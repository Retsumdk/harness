import { test, expect } from "bun:test";
import { createApp } from "../src";
import { ChatService, MemoryStore, MockProvider, ToolRegistry } from "../src";

export const build = () => {
  const store = new MemoryStore();
  const chat = new ChatService(store, new Map([["mock", new MockProvider()]]), new ToolRegistry());
  return { store, app: createApp({ store, chat, token: "s3cret", modules: () => [{ id: "core" }] }) };
};
const auth = { authorization: "Bearer s3cret" };

test("/health is open and lists modules", async () => {
  const r = await build().app.request("/health");
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ ok: true, modules: [{ id: "core" }] });
});

test("api rejects missing, malformed and wrong tokens with 401", async () => {
  const { app } = build();
  for (const h of [undefined, "s3cret", "Bearer nope", "Bearer s3cret1", "Basic s3cret"]) {
    const r = await app.request("/api/conversations", { headers: h ? { authorization: h } : {} });
    expect(r.status).toBe(401);
    expect((await r.json()).error.code).toBe("unauthorized");
  }
  const w = await app.request("/api/chat", { method: "POST", body: "{}" });
  expect(w.status).toBe(401);
});

test("valid token passes; createApp refuses an empty token", async () => {
  const { app } = build();
  expect((await app.request("/api/conversations", { headers: auth })).status).toBe(200);
  const { store } = build();
  expect(() => createApp({ store, chat: null as any, token: "" })).toThrow("HARNESS_TOKEN");
});
