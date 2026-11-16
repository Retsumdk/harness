import { describe, expect, test } from "bun:test";
import {
  ChatService, MemoryStore, MockProvider, ModuleError, ModuleService, Registry, ToolRegistry, createApp,
} from "../src";

interface Probe { id: string; starts: number; stops: number }

const buildRegistry = () => {
  const registry = new Registry();
  const probes = new Map<string, Probe>();
  const add = (id: string, requires: string[] = []) => {
    const probe: Probe = { id, starts: 0, stops: 0 };
    probes.set(id, probe);
    registry.register({
      id,
      requires,
      start: () => { probe.starts++; },
      stop: () => { probe.stops++; },
    });
  };
  add("store");
  add("chat", ["store"]);
  add("agents", ["chat"]);
  return { registry, probes };
};

const TOKEN = "module-token";
const buildApp = (modules: ModuleService) => {
  const store = new MemoryStore();
  const chat = new ChatService(store, new Map([["mock", new MockProvider()]]), new ToolRegistry());
  const app = createApp({ store, chat, token: TOKEN, moduleService: modules });
  return { app, auth: { authorization: `Bearer ${TOKEN}` } };
};

describe("modules.toggle", () => {
  test("list reports state, dependencies and dependants", async () => {
    const { registry } = buildRegistry();
    const modules = new ModuleService(registry);
    await registry.start(["store"]);

    const byId = Object.fromEntries(modules.list().map((m) => [m.id, m]));
    expect(byId.store.state).toBe("running");
    expect(byId.chat.state).toBe("registered");
    expect(byId.chat.missing).toEqual([]);
    expect(byId.agents.missing).toEqual(["chat"]);
    expect(byId.store.dependants).toEqual([]);

    await registry.start(["chat"]);
    expect(modules.view("store").dependants).toEqual(["chat"]);
    expect(modules.view("chat").missing).toEqual([]);
  });

  test("enabling a module starts its dependencies first, once", async () => {
    const { registry, probes } = buildRegistry();
    const modules = new ModuleService(registry);
    const view = await modules.enable("agents");
    expect(view.state).toBe("running");
    expect(probes.get("store")!.starts).toBe(1);
    expect(probes.get("chat")!.starts).toBe(1);
    expect(probes.get("agents")!.starts).toBe(1);

    await modules.enable("agents");
    expect(probes.get("agents")!.starts).toBe(1);
  });

  test("a module cannot be stopped while a running module still requires it", async () => {
    const { registry, probes } = buildRegistry();
    const modules = new ModuleService(registry);
    await modules.enable("agents");

    try {
      await modules.disable("store");
      throw new Error("expected the disable to be refused");
    } catch (e) {
      expect(e).toBeInstanceOf(ModuleError);
      expect((e as ModuleError).code).toBe("in_use");
      expect((e as Error).message).toContain("chat");
    }

    await modules.disable("agents");
    await modules.disable("chat");
    const stopped = await modules.disable("store");
    expect(stopped.state).toBe("stopped");
    expect(probes.get("store")!.stops).toBe(1);

    const restarted = await modules.enable("store");
    expect(restarted.state).toBe("running");
    expect(probes.get("store")!.starts).toBe(2);
  });

  test("an unknown module is a not-found error, not a crash", async () => {
    const { registry } = buildRegistry();
    const modules = new ModuleService(registry);
    try {
      await modules.enable("nope");
      throw new Error("expected unknown module");
    } catch (e) {
      expect((e as ModuleError).code).toBe("unknown");
    }
  });

  test("toggling is exposed over HTTP behind the bearer token", async () => {
    const { registry } = buildRegistry();
    const modules = new ModuleService(registry);
    await registry.start(["store", "chat"]);
    const { app, auth } = buildApp(modules);

    expect((await app.request("/api/modules")).status).toBe(401);

    const listed = await app.request("/api/modules", { headers: auth });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { modules: { id: string; state: string }[] };
    expect(body.modules.map((m) => m.id)).toEqual(["store", "chat", "agents"]);
    expect(body.modules.find((m) => m.id === "chat")!.state).toBe("running");

    expect((await app.request("/api/modules/agents/enable", { method: "POST", headers: auth })).status).toBe(200);

    const inUse = await app.request("/api/modules/chat/disable", { method: "POST", headers: auth });
    expect(inUse.status).toBe(409);
    expect(((await inUse.json()) as any).error.code).toBe("in_use");

    const missing = await app.request("/api/modules/nope/disable", { method: "POST", headers: auth });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as any).error.code).toBe("unknown");
  });

  test("/health lists the module registry so a cold client can see what is running", async () => {
    const { registry } = buildRegistry();
    const modules = new ModuleService(registry);
    await registry.start(["store"]);
    const { app } = buildApp(modules);
    const health = (await (await app.request("/health")).json()) as any;
    expect(health.modules.map((m: any) => m.id)).toEqual(["store", "chat", "agents"]);
    expect(health.modules[0].state).toBe("running");
  });
});
