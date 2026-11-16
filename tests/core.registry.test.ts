import { describe, expect, test } from "bun:test";
import { Registry, RegistryError, type Module } from "../src";

const mod = (id: string, requires: string[] = [], log: string[] = []): Module => ({
  id, requires, start: () => { log.push(`start:${id}`); }, stop: () => { log.push(`stop:${id}`); },
});

describe("core.registry", () => {
  test("starts modules dependencies-first", async () => {
    const log: string[] = [];
    const r = new Registry();
    r.register(mod("chat", ["providers", "store"], log));
    r.register(mod("providers", [], log));
    r.register(mod("store", [], log));
    await r.start();
    expect(log.indexOf("start:chat")).toBeGreaterThan(log.indexOf("start:providers"));
    expect(log.indexOf("start:chat")).toBeGreaterThan(log.indexOf("start:store"));
    expect(r.stateOf("chat")).toBe("running");
  });
  test("rejects duplicates, unknown ids, missing deps and cycles", async () => {
    const r = new Registry();
    r.register(mod("a", ["b"]));
    r.register(mod("b", ["a"]));
    expect(() => r.register(mod("a"))).toThrow(RegistryError);
    expect(() => r.get("zzz")).toThrow(/unknown module/);
    await expect(r.start()).rejects.toThrow(/cycle/);
    const r2 = new Registry();
    r2.register(mod("x", ["ghost"]));
    await expect(r2.start()).rejects.toThrow(/missing module "ghost"/);
  });
  test("disable refuses while a running module depends on it, then succeeds", async () => {
    const r = new Registry();
    r.register(mod("tools")); r.register(mod("agents", ["tools"]));
    await r.start();
    await expect(r.disable("tools")).rejects.toMatchObject({ code: "in_use" });
    await r.disable("agents");
    await r.disable("tools");
    expect(r.stateOf("tools")).toBe("stopped");
    await r.enable("agents");
    expect(r.stateOf("tools")).toBe("running");
    expect(r.list().map((m) => m.id).sort()).toEqual(["agents", "tools"]);
  });
  test("emits lifecycle events and stopAll stops in reverse order", async () => {
    const log: string[] = [];
    const r = new Registry();
    const seen: string[] = [];
    r.bus.on<{ id: string }>("module:started", (p) => { seen.push(p.id); });
    r.register(mod("a", [], log)); r.register(mod("b", ["a"], log));
    await r.start();
    await r.stopAll();
    expect(seen).toEqual(["a", "b"]);
    expect(log.filter((l) => l.startsWith("stop"))).toEqual(["stop:b", "stop:a"]);
  });
  test("event bus unsubscribe works", async () => {
    const r = new Registry(); let n = 0;
    const off = r.bus.on("t", () => { n++; });
    await r.bus.emit("t", 1); off(); await r.bus.emit("t", 1); await r.bus.emit("none", 1);
    expect(n).toBe(1);
  });
});
