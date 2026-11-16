import { Hono } from "hono";
import type { Store } from "../store/types";
import type { ChatService } from "../chat/service";
import type { AgentService } from "../agents/service";
import { AgentError } from "../agents/types";
import type { PluginService } from "../plugins/service";
import type { ModuleService } from "../core/modules";
import type { WorkspaceLike } from "../fs/types";
import { registerModuleRoutes, registerPluginRoutes } from "./routes-plugins";
import { readSettings, registerWorkspaceRoutes, SETTING_PROVIDER } from "./routes-workspace";

export interface AppDeps {
  store: Store; chat: ChatService; token: string; version?: string; modules?: () => unknown[];
  agents?: AgentService;
  plugins?: PluginService;
  moduleService?: ModuleService;
  /** When present, the file and settings routes are mounted. */
  workspace?: WorkspaceLike;
  tools?: () => string[];
}

const err = (code: string, message: string) => ({ error: { code, message } });
/** Constant-time string compare without a Node-only import, so the same app runs
 *  in the browser demo. Lengths are compared first; equal-prefix timing does not
 *  reveal the token beyond the length comparison. */
const same = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export function createApp(deps: AppDeps): Hono {
  if (!deps.token) throw new Error("HARNESS_TOKEN is required");
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true, version: deps.version ?? "0.1.0", modules: deps.modules?.() ?? deps.moduleService?.list() ?? [] }));

  app.use("/api/*", async (c, next) => {
    const h = c.req.header("authorization") ?? "";
    if (!h.startsWith("Bearer ") || !same(h.slice(7), deps.token)) return c.json(err("unauthorized", "missing or invalid bearer token"), 401);
    await next();
  });

  // A stopped module takes its routes offline with a 409 instead of silently serving.
  const ownedBy: [string, string][] = [
    ["/api/chat", "chat"], ["/api/conversations", "chat"],
    ["/api/agents", "agents"], ["/api/runs", "agents"],
    ["/api/plugins", "plugins"], ["/api/files", "fs"],
  ];
  app.use("/api/*", async (c, next) => {
    if (!deps.moduleService) return next();
    const owner = ownedBy.find(([prefix]) => c.req.path === prefix || c.req.path.startsWith(prefix + "/"));
    if (!owner) return next();
    const module = deps.moduleService.list().find((m) => m.id === owner[1]);
    if (module && module.state !== "running")
      return c.json(err("module_disabled", `module "${owner[1]}" is stopped; start it under Plugins → Capability modules`), 409);
    return next();
  });

  app.post("/api/chat", async (c) => {
    let body: any;
    try { body = await c.req.json(); } catch { return c.json(err("bad_request", "body must be JSON"), 400); }
    if (typeof body?.message !== "string" || !body.message.trim()) return c.json(err("bad_request", "\"message\" must be a non-empty string"), 400);
    if (body.message.length > 20000) return c.json(err("bad_request", "\"message\" exceeds 20000 chars"), 400);
    for (const k of ["conversationId", "provider", "model"]) if (body[k] !== undefined && typeof body[k] !== "string") return c.json(err("bad_request", `"${k}" must be a string`), 400);
    const stored = await readSettings(deps.store);
    if (!body.provider && stored.provider && deps.chat.providerIds().includes(stored.provider)) body.provider = stored.provider;
    if (!body.model && stored.model) body.model = stored.model;
    if (body.provider && !deps.chat.providerIds().includes(body.provider)) return c.json(err("bad_request", `unknown provider "${body.provider}"`), 400);
    if (body.conversationId && !(await deps.store.getConversation(body.conversationId))) return c.json(err("not_found", "conversation not found"), 404);
    const gen = deps.chat.send({ conversationId: body.conversationId, message: body.message, provider: body.provider, model: body.model, signal: c.req.raw.signal });
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async pull(ctrl) {
        const r = await gen.next();
        if (r.done) { ctrl.close(); return; }
        ctrl.enqueue(enc.encode(`event: ${r.value.type}\ndata: ${JSON.stringify(r.value)}\n\n`));
      },
      cancel() { void gen.return(undefined); },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  });

  app.get("/api/conversations", async (c) => c.json({ conversations: await deps.store.listConversations() }));
  app.get("/api/conversations/:id", async (c) => {
    const conv = await deps.store.getConversation(c.req.param("id"));
    if (!conv) return c.json(err("not_found", "conversation not found"), 404);
    return c.json({ conversation: conv, messages: await deps.store.listMessages(conv.id) });
  });
  app.delete("/api/conversations/:id", async (c) => {
    if (!(await deps.store.deleteConversation(c.req.param("id")))) return c.json(err("not_found", "conversation not found"), 404);
    return c.json({ ok: true });
  });

  if (deps.workspace) registerWorkspaceRoutes(app, {
    store: deps.store, workspace: deps.workspace, chat: deps.chat, version: deps.version,
    tools: deps.tools, modules: () => deps.moduleService?.list() ?? [],
  });

  if (deps.agents) registerAgentRoutes(app, deps.agents, deps.store);
  if (deps.plugins) registerPluginRoutes(app, deps.plugins);
  if (deps.moduleService) registerModuleRoutes(app, deps.moduleService);

  app.notFound((c) => c.json(err("not_found", `no route ${c.req.method} ${c.req.path}`), 404));
  app.onError((e, c) => c.json(err("internal", "internal error"), 500));
  return app;
}

function agentError(c: any, e: unknown) {
  if (e instanceof AgentError) {
    const status = e.code === "not_found" ? 404 : e.code === "conflict" ? 409 : e.code === "depth_exceeded" ? 409 : 400;
    return c.json(err(e.code === "not_found" ? "not_found" : "bad_request", e.message), status);
  }
  throw e;
}

const asString = (v: unknown) => (typeof v === "string" ? v : undefined);

function registerAgentRoutes(app: Hono, agents: AgentService, store: Store): void {
  const readBody = async (c: any): Promise<Record<string, unknown> | undefined> => {
    try {
      const body = await c.req.json();
      return body && typeof body === "object" && !Array.isArray(body) ? body : undefined;
    } catch {
      return undefined;
    }
  };

  app.get("/api/agents", async (c) => c.json({ agents: await agents.listAgents() }));

  app.post("/api/agents", async (c) => {
    const body = await readBody(c);
    if (!body) return c.json(err("bad_request", "body must be a JSON object"), 400);
    if (body.provider === undefined) {
      const preferred = await store.getSetting(SETTING_PROVIDER);
      if (preferred) body.provider = preferred;
    }
    try {
      return c.json({ agent: await agents.createAgent(body as any) }, 201);
    } catch (e) { return agentError(c, e); }
  });

  app.get("/api/agents/:id", async (c) => {
    try { return c.json({ agent: await agents.getAgent(c.req.param("id")) }); }
    catch (e) { return agentError(c, e); }
  });

  const update = async (c: any) => {
    const body = await readBody(c);
    if (!body) return c.json(err("bad_request", "body must be a JSON object"), 400);
    try { return c.json({ agent: await agents.updateAgent(c.req.param("id"), body as any) }); }
    catch (e) { return agentError(c, e); }
  };
  app.patch("/api/agents/:id", update);
  app.put("/api/agents/:id", update);

  app.delete("/api/agents/:id", async (c) => {
    const deleted = await agents.deleteAgent(c.req.param("id"));
    if (!deleted) return c.json(err("not_found", "agent not found"), 404);
    return c.json({ ok: true });
  });

  app.post("/api/agents/:id/runs", async (c) => {
    const body = await readBody(c);
    const input = asString(body?.input);
    if (!input) return c.json(err("bad_request", "\"input\" must be a non-empty string"), 400);
    try {
      const { runId, done } = await agents.start(c.req.param("id"), input);
      void done.catch(() => {});
      return c.json({ runId }, 202);
    } catch (e) { return agentError(c, e); }
  });

  app.get("/api/runs", async (c) => {
    const agentId = c.req.query("agentId");
    if (agentId) {
      try { await agents.getAgent(agentId); } catch (e) { return agentError(c, e); }
    }
    return c.json({ runs: await agents.listRuns(agentId) });
  });

  app.get("/api/runs/:id", async (c) => {
    try { return c.json({ run: await agents.getRun(c.req.param("id")) }); }
    catch (e) { return agentError(c, e); }
  });

  app.post("/api/runs/:id/cancel", async (c) => {
    try { return c.json({ cancelled: await agents.cancel(c.req.param("id")) }); }
    catch (e) { return agentError(c, e); }
  });

  app.get("/api/runs/:id/stream", async (c) => {
    let run;
    try { run = await agents.getRun(c.req.param("id")); }
    catch (e) { return agentError(c, e); }
    const enc = new TextEncoder();
    const terminal = (s: string) => s !== "running";
    const deadline = Date.now() + 60_000;
    let timer: ReturnType<typeof setInterval> | null = null;
    let stopped = false;
    let sent = 0;
    let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (timer !== null) { clearInterval(timer); timer = null; }
      try { ctrl?.close(); } catch { /* the consumer already closed it */ }
    };
    const send = (event: string, data: unknown) => {
      if (stopped || !ctrl) return;
      try { ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); }
      catch { stop(); }
    };

    // A timer drives this feed, not `pull()`. The stream only pulls again once the
    // queue is empty *and* a read is outstanding, so a pass that found no new steps
    // returned without enqueuing and was never re-invoked: the viewer sat on
    // "running" for ever while the run itself finished. Same shape as POST /api/chat.
    const tick = async () => {
      if (stopped) return;
      const current = await agents.getRun(run.id).catch(() => run);
      if (stopped) return;
      while (sent < current.steps.length) { send("step", current.steps[sent]); sent++; }
      if (terminal(current.status)) {
        send("done", { status: current.status, output: current.output, error: current.error });
        stop();
        return;
      }
      if (Date.now() >= deadline) {
        send("error", { code: "timeout", message: "run still in progress; reconnect" });
        stop();
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        ctrl = controller;
        timer = setInterval(() => { void tick(); }, 100);
        c.req.raw.signal?.addEventListener?.("abort", stop, { once: true });
        void tick();
      },
      cancel() { stop(); },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  });
}
