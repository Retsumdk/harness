import { test, expect } from "bun:test";
import { createApp, ChatService, MemoryStore, MockProvider, ToolRegistry } from "../src";

const mk = () => {
  const store = new MemoryStore();
  const chat = new ChatService(store, new Map([["mock", new MockProvider()]]), new ToolRegistry());
  return createApp({ store, chat, token: "t" });
};
const H = { authorization: "Bearer t", "content-type": "application/json" };
const post = (app: any, body: string) => app.request("/api/chat", { method: "POST", headers: H, body });

test("chat validation: bad JSON, empty, wrong types, oversize, unknown provider", async () => {
  const app = mk();
  for (const b of ["{nope", "{}", '{"message":"  "}', '{"message":5}', '{"message":"a","model":3}', '{"message":"a","provider":"zzz"}', JSON.stringify({ message: "x".repeat(20001) })]) {
    const r = await post(app, b);
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("bad_request");
  }
});

test("unknown conversation -> 404 with error contract", async () => {
  const app = mk();
  const r = await post(app, '{"message":"hi","conversationId":"nope"}');
  expect(r.status).toBe(404);
  expect(await r.json()).toEqual({ error: { code: "not_found", message: "conversation not found" } });
  expect((await app.request("/api/conversations/nope", { headers: H })).status).toBe(404);
  expect((await app.request("/api/conversations/nope", { method: "DELETE", headers: H })).status).toBe(404);
});

test("unknown route -> JSON 404", async () => {
  const r = await mk().request("/x");
  expect(r.status).toBe(404);
  expect((await r.json()).error.code).toBe("not_found");
});

test("SSE chat end to end, then history and delete", async () => {
  const app = mk();
  const r = await post(app, '{"message":"hello world"}');
  expect(r.headers.get("content-type")).toContain("text/event-stream");
  const text = await r.text();
  expect(text).toContain("event: token");
  expect(text).toContain("event: done");
  const id = /"conversationId":"([^"]+)"/.exec(text)![1];
  const hist = await (await app.request(`/api/conversations/${id}`, { headers: H })).json();
  expect(hist.messages.length).toBe(2);
  expect((await app.request(`/api/conversations/${id}`, { method: "DELETE", headers: H })).status).toBe(200);
  expect((await (await app.request("/api/conversations", { headers: H })).json()).conversations).toEqual([]);
});

test("unexpected failures return 500 without leaking details", async () => {
  const store = new MemoryStore();
  store.listConversations = async () => { throw new Error("secret path /etc"); };
  const app = createApp({ store, chat: new ChatService(store, new Map(), new ToolRegistry()), token: "t" });
  const r = await app.request("/api/conversations", { headers: H });
  expect(r.status).toBe(500);
  expect(JSON.stringify(await r.json())).not.toContain("secret");
});
