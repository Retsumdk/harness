/**
 * The demo kernel: the same store contract, tool registry, chat service, agent
 * runner, plugin service and module registry the server boots, assembled over
 * browser-safe implementations (localStorage + an in-memory workspace) and the
 * keyless mock provider. `createApp` then mounts the real routes over it, so a
 * request from the demo UI takes the identical path a request from `curl` takes.
 *
 * What is deliberately absent in a tab: `shell.run` (no processes) and real
 * model providers (no keys). Both are listed as demo exclusions in DELIVERY.md.
 */
import type { Hono } from "hono";
import { Registry } from "../core/registry";
import { ModuleService } from "../core/modules";
import { ToolRegistry } from "../tools/registry";
import { registerFsTools } from "../tools/fs-tools";
import { MockProvider } from "../providers/mock";
import { ChatService } from "../chat/service";
import { AgentService } from "../agents/service";
import { PluginService } from "../plugins/service";
import { createApp } from "../server/app";
import { seedIfNeeded, writeSeedFiles, type SeedResult } from "../server/seed";
import type { Store } from "../store/types";
import { MemoryWorkspace } from "./memory-workspace";
import { PersistentStore, type StorageLike } from "./store";

/** The demo never asks for a credential; this token exists so the same auth
 *  middleware runs and a stray cross-tab request is still rejected. */
export const DEMO_TOKEN = "demo-token";
export const DEMO_VERSION = "0.1.0";
const FS_TOOLS = ["fs.read", "fs.write", "fs.list", "fs.search"];

export interface DemoKernelOptions {
  /** Omitted: the browser's localStorage when it works, otherwise memory-only. */
  storage?: StorageLike | null;
  seed?: boolean;
  /** Word delay in the mock provider, so streaming reads as streaming. */
  tokenDelayMs?: number;
}

export interface DemoKernel {
  app: Hono;
  store: Store;
  workspace: MemoryWorkspace;
  seed: SeedResult;
}

/** localStorage when it is actually writable; private modes throw instead. */
export function browserStorage(): StorageLike | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const probe = "harness.demo.probe";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

export async function createDemoKernel(opts: DemoKernelOptions = {}): Promise<DemoKernel> {
  const store = new PersistentStore(opts.storage === undefined ? browserStorage() : opts.storage);
  const workspace = new MemoryWorkspace();
  const tools = new ToolRegistry();
  const providers = new Map([["mock", new MockProvider(opts.tokenDelayMs ?? 6)]]);
  const registry = new Registry();

  const chat = new ChatService(store, providers, tools, "mock");
  const agents = new AgentService({ store, providers, tools });
  const plugins = new PluginService({ store, tools, bus: registry.bus });

  registry.register({ id: "core", version: DEMO_VERSION });
  registry.register({ id: "fs", version: DEMO_VERSION, requires: ["core"] });
  registry.register({
    id: "tools",
    version: DEMO_VERSION,
    requires: ["fs"],
    start: () => { registerFsTools(tools, workspace); },
    stop: () => { for (const name of FS_TOOLS) tools.unregister(name); },
  });
  registry.register({ id: "providers", version: DEMO_VERSION, requires: ["core"] });
  registry.register({ id: "chat", version: DEMO_VERSION, requires: ["providers", "tools"] });
  registry.register({ id: "agents", version: DEMO_VERSION, requires: ["chat"] });
  registry.register({
    id: "plugins",
    version: DEMO_VERSION,
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

  const empty = { seeded: false, agents: 0, conversations: 0, runs: 0, files: 0 };
  const seed = opts.seed === false ? empty : await seedIfNeeded({ store, workspace, agents });
  // The store survives a reload in localStorage; the workspace does not. Restore the
  // files so a returning visitor never lands on an empty workspace.
  if (workspace.paths().length === 0) writeSeedFiles(workspace);

  const app = createApp({
    store, chat, agents, plugins, moduleService: modules, workspace,
    token: DEMO_TOKEN, version: DEMO_VERSION, tools: () => tools.names(),
  });

  return { app, store, workspace, seed };
}
