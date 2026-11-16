import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { Registry } from "../core/registry";
import { ModuleService } from "../core/modules";
import { SqliteStore } from "../store/sqlite";
import { MemoryStore } from "../store/memory";
import type { Store } from "../store/types";
import { ToolRegistry } from "../tools/registry";
import { registerBuiltins } from "../tools/builtins";
import { Workspace } from "../fs/workspace";
import { MockProvider } from "../providers/mock";
import { OpenAICompatProvider } from "../providers/openai";
import type { Provider } from "../providers/types";
import { ChatService } from "../chat/service";
import { AgentService } from "../agents/service";
import { PluginService } from "../plugins/service";
import { createApp } from "./app";
import { readSettings } from "./routes-workspace";
import { seedIfNeeded } from "./seed";

export const VERSION = "0.1.0";

export interface HarnessOptions {
  /** Directory holding the database and the workspace; created if missing. */
  home: string;
  token: string;
  store?: Store;
  providers?: Map<string, Provider>;
  /** Built web client. Served when it exists; a build hint is served when it does not. */
  staticRoot?: string;
  seed?: boolean;
}

export interface Harness {
  app: Hono;
  store: Store;
  registry: Registry;
  modules: ModuleService;
  workspace: Workspace;
  tools: ToolRegistry;
  chat: ChatService;
  agents: AgentService;
  plugins: PluginService;
  seed: { seeded: boolean; agents: number; conversations: number; runs: number; files: number };
}

const BUILTIN_TOOLS = ["fs.read", "fs.write", "fs.list", "fs.search", "shell.run"];

/** Providers come from env; the mock is always present so the app runs with no keys. */
export function defaultProviders(env: NodeJS.ProcessEnv = process.env): Map<string, Provider> {
  const providers = new Map<string, Provider>([["mock", new MockProvider()]]);
  const baseUrl = env.OPENAI_BASE_URL;
  if (baseUrl) {
    providers.set("openai-compat", new OpenAICompatProvider({
      baseUrl, apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL ?? "gpt-4o-mini",
    }));
  }
  return providers;
}

/**
 * No run can survive the process that started it. A run left at "running" by a
 * crash would show a spinner that never resolves and block cancellation, so boot
 * closes it as failed with the reason. Returns how many were closed.
 */
export async function recoverInterruptedRuns(store: Store): Promise<number> {
  let closed = 0;
  for (const run of await store.listRuns()) {
    if (run.status !== "running") continue;
    await store.updateRun(run.id, { status: "failed", error: "interrupted by a server restart", endedAt: Date.now() });
    closed++;
  }
  return closed;
}

/**
 * Assembles the whole product: store, workspace, tools, providers, chat, agents,
 * plugins and the module registry, then mounts the HTTP app over them.
 */
export async function createHarness(opts: HarnessOptions): Promise<Harness> {
  if (!opts.token) throw new Error("HARNESS_TOKEN is required: refusing to boot without auth");
  mkdirSync(opts.home, { recursive: true });
  const store = opts.store ?? new SqliteStore(join(opts.home, "harness.db"));
  await recoverInterruptedRuns(store);
  const workspace = new Workspace(join(opts.home, "workspace"));
  const tools = new ToolRegistry();
  const providers = opts.providers ?? defaultProviders();
  const registry = new Registry();

  const chat = new ChatService(store, providers, tools, "mock");
  const agents = new AgentService({ store, providers, tools });
  const plugins = new PluginService({ store, tools, bus: registry.bus });

  registry.register({ id: "core", version: VERSION });
  registry.register({ id: "fs", version: VERSION, requires: ["core"] });
  registry.register({
    id: "tools",
    version: VERSION,
    requires: ["fs"],
    start: () => { registerBuiltins(tools, workspace); },
    stop: () => { for (const name of BUILTIN_TOOLS) tools.unregister(name); },
  });
  registry.register({ id: "providers", version: VERSION, requires: ["core"] });
  registry.register({ id: "chat", version: VERSION, requires: ["providers", "tools"] });
  registry.register({ id: "agents", version: VERSION, requires: ["chat"] });
  registry.register({
    id: "plugins",
    version: VERSION,
    requires: ["tools"],
    stop: async () => {
      for (const view of await plugins.list()) {
        if (view.enabled) await plugins.disable(view.id).catch(() => {});
      }
    },
  });

  const modules = new ModuleService(registry);
  for (const mod of registry.list()) {
    await registry.enable(mod.id).catch((e) => { throw new Error(`module "${mod.id}" failed to start: ${(e as Error).message}`); });
  }

  const seeded = opts.seed === false
    ? { seeded: false, agents: 0, conversations: 0, runs: 0, files: 0 }
    : await seedIfNeeded({ store, workspace, agents });

  const app = createApp({
    store, chat, agents, plugins, moduleService: modules, workspace, token: opts.token,
    version: VERSION, tools: () => tools.names(),
  });

  mountStatic(app, opts.staticRoot);
  return { app, store, registry, modules, workspace, tools, chat, agents, plugins, seed: seeded };
}

const NO_BUILD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>HARNESS</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e6e9ef;
font:15px/1.6 ui-sans-serif,system-ui,sans-serif}main{max-width:38rem;padding:2rem}
code{background:#1b1f27;padding:.15rem .4rem;border-radius:.25rem;color:#6ee7b7}
h1{font-size:1.4rem;margin:0 0 .5rem}p{color:#8b93a1}</style></head>
<body><main><h1>HARNESS is running</h1>
<p>The API is live but the web client has not been built yet.</p>
<p>Build it with <code>bun run build:web</code> and reload this page.</p>
<p>The HTTP API works now: <code>GET /health</code> needs no token, every <code>/api/*</code> route needs
<code>Authorization: Bearer &lt;HARNESS_TOKEN&gt;</code>.</p></main></body></html>`;

/**
 * Serves the built React client with an SPA fallback. Unknown /api paths keep
 * returning the JSON error contract instead of the index document.
 */
export function mountStatic(app: Hono, staticRoot?: string): void {
  const indexFile = staticRoot ? join(staticRoot, "index.html") : undefined;
  if (staticRoot && indexFile && existsSync(indexFile)) {
    app.use("*", serveStatic({ root: staticRoot }));
    app.get("*", async (c) => {
      if (c.req.path.startsWith("/api/")) return c.json({ error: { code: "not_found", message: `no route ${c.req.method} ${c.req.path}` } }, 404);
      if (c.req.path === "/health") return c.json({ error: { code: "not_found", message: "no route" } }, 404);
      return c.html(await Bun.file(indexFile).text());
    });
    return;
  }
  app.get("/", (c) => c.html(NO_BUILD_HTML));
}

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

if (import.meta.main) {
  const home = env("HARNESS_HOME", join(process.cwd(), ".harness"));
  const token = process.env.HARNESS_TOKEN;
  if (!token) {
    console.error("[harness] HARNESS_TOKEN is not set. Create .env from .env.example, or export HARNESS_TOKEN.");
    process.exit(1);
  }
  const staticRoot = env("HARNESS_WEB_DIST", join(import.meta.dir, "../../dist/web"));
  const harness = await createHarness({ home, token, staticRoot });
  const port = Number(env("HARNESS_PORT", "8787"));
  const server = Bun.serve({
    port,
    fetch: harness.app.fetch,
    error(e) { console.error("[harness] unhandled:", e); return Response.json({ error: { code: "internal", message: "internal error" } }, { status: 500 }); },
  });
  const settings = await readSettings(harness.store);
  console.log(`[harness] listening on http://localhost:${server.port} (home: ${home})`);
  console.log(`[harness] providers: ${harness.chat.providerIds().join(", ")} | default: ${settings.provider || "mock"}`);
  console.log(`[harness] seeded: ${harness.seed.seeded ? `${harness.seed.agents} agents, ${harness.seed.conversations} conversations, ${harness.seed.files} files` : "store already had data"}`);
  if (!existsSync(join(staticRoot, "index.html"))) console.warn(`[harness] web client not built — run "bun run build:web" (looked in ${staticRoot})`);
}

export { MemoryStore };
