import { test, expect } from "bun:test";
import { ChatService, type ChatEvent } from "../src/chat/service";
import { MemoryStore, MockProvider, ToolRegistry, ProviderError, type Provider } from "../src";

const collect = async (g: AsyncIterable<ChatEvent>) => { const o: ChatEvent[] = []; for await (const e of g) o.push(e); return o; };
const mk = () => {
  const store = new MemoryStore(); const tools = new ToolRegistry();
  tools.register({ name: "echo", description: "e", schema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] }, run: (a) => `got ${a.x}` });
  return { store, tools, chat: new ChatService(store, new Map<string, Provider>([["mock", new MockProvider()]]), tools) };
};

test("streams tokens then done and persists both messages", async () => {
  const { chat, store } = mk();
  const ev = await collect(chat.send({ message: "hello there" }));
  expect(ev.filter((e) => e.type === "token").length).toBeGreaterThan(1);
  const done = ev.at(-1)!;
  expect(done.type).toBe("done");
  const msgs = await store.listMessages((done as any).conversationId);
  expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(msgs[1].content).toBe("You said: hello there");
});

test("tool-call loop runs the tool and feeds result back", async () => {
  const { chat, store } = mk();
  const ev = await collect(chat.send({ message: '/tool echo {"x":"hi"}' }));
  expect(ev.find((e) => e.type === "tool_result")).toMatchObject({ result: "got hi" });
  const id = (ev.at(-1) as any).conversationId;
  expect((await store.listMessages(id)).map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  expect(ev.filter((e) => e.type === "token").map((e: any) => e.text).join("")).toBe("Tool result: got hi");
});

test("invalid tool args surface as tool_result error, loop continues", async () => {
  const { chat } = mk();
  const ev = await collect(chat.send({ message: "/tool echo {}" }));
  expect((ev.find((e) => e.type === "tool_result") as any).error).toContain("missing required");
  expect(ev.at(-1)!.type).toBe("done");
});

test("continues an existing conversation; unknown id throws not_found", async () => {
  const { chat, store } = mk();
  const first = await collect(chat.send({ message: "one" }));
  const id = (first.at(-1) as any).conversationId;
  await collect(chat.send({ conversationId: id, message: "two" }));
  expect((await store.listMessages(id)).length).toBe(4);
  await expect(collect(chat.send({ conversationId: "nope", message: "x" }))).rejects.toThrow("not found");
});

test("unknown provider yields error event", async () => {
  const { chat } = mk();
  const ev = await collect(chat.send({ message: "x", provider: "zzz" }));
  expect(ev[0]).toMatchObject({ type: "error", code: "unknown_provider" });
  expect(chat.providerIds()).toEqual(["mock"]);
});

test("provider failures become error events (429 -> rate_limited)", async () => {
  const bad = (status: number): Provider => ({ id: "bad", async *stream() { throw new ProviderError(status, "boom"); } });
  for (const [s, code] of [[429, "rate_limited"], [500, "provider_error"]] as const) {
    const store = new MemoryStore();
    const chat = new ChatService(store, new Map([["bad", bad(s)]]), new ToolRegistry(), "bad");
    expect((await collect(chat.send({ message: "x" }))).at(-1)).toMatchObject({ type: "error", code });
  }
});

test("tool loop is capped", async () => {
  const looper: Provider = { id: "l", async *stream() { yield { type: "tool_call", call: { id: "c", name: "echo", args: { x: "a" } } }; yield { type: "done" }; } };
  const { tools, store } = mk();
  const chat = new ChatService(store, new Map([["l", looper]]), tools, "l");
  const ev = await collect(chat.send({ message: "x", maxToolRounds: 2 }));
  expect(ev.at(-1)).toMatchObject({ type: "error", code: "tool_loop_limit" });
});
