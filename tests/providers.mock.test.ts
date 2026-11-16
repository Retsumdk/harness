import { describe, expect, test } from "bun:test";
import { MockProvider, OpenAICompatProvider, ProviderError, type Chunk } from "../src";

const collect = async (it: AsyncIterable<Chunk>) => { const o: Chunk[] = []; for await (const c of it) o.push(c); return o; };
const text = (cs: Chunk[]) => cs.filter((c) => c.type === "token").map((c: any) => c.text).join("");

describe("providers.mock", () => {
  test("echoes and streams tokens ending in done", async () => {
    const cs = await collect(new MockProvider().stream([{ role: "user", content: "hello world" }]));
    expect(text(cs)).toBe("You said: hello world");
    expect(cs.at(-1)?.type).toBe("done");
  });
  test("empty input gets a prompt, not a blank reply", async () => {
    expect(text(await collect(new MockProvider().stream([{ role: "user", content: "" }])))).toContain("Say something");
  });
  test("/tool emits a call when the tool exists, refuses when not, summarises results", async () => {
    const tools = [{ name: "fs.read", description: "", parameters: {} }];
    const p = new MockProvider();
    const call = (await collect(p.stream([{ role: "user", content: '/tool fs.read {"path":"a.txt"}' }], tools))).find((c) => c.type === "tool_call") as any;
    expect(call.call).toMatchObject({ name: "fs.read", args: { path: "a.txt" } });
    expect(text(await collect(p.stream([{ role: "user", content: "/tool nope" }], tools)))).toContain("don't have a tool");
    expect(text(await collect(p.stream([{ role: "tool", content: "ok" }], tools)))).toBe("Tool result: ok");
    const bad = (await collect(p.stream([{ role: "user", content: "/tool fs.read {bad}" }], tools))).find((c) => c.type === "tool_call") as any;
    expect(bad.call.args).toEqual({});
    expect(text(await collect(p.stream([{ role: "user", content: "/tool fs.read {bad" }], tools)))).toBe("You said: /tool fs.read {bad");
    const noargs = (await collect(p.stream([{ role: "user", content: "/tool fs.read" }], tools))).find((c) => c.type === "tool_call") as any;
    expect(noargs.call.args).toEqual({});
  });
  test("stops when aborted", async () => {
    const ac = new AbortController(); ac.abort();
    expect(await collect(new MockProvider(1).stream([{ role: "user", content: "a b c" }], [], { signal: ac.signal }))).toEqual([]);
  });
});

const sse = (lines: string[]) => new Response(new ReadableStream({ start(c) { const e = new TextEncoder(); for (const l of lines) c.enqueue(e.encode(l)); c.close(); } }));

describe("providers.openai-compat", () => {
  test("parses streamed tokens, usage and sends auth + tools", async () => {
    let req: any;
    const f = (async (url: string, init: any) => { req = { url, init, body: JSON.parse(init.body) };
      return sse(['data: {"choices":[{"delta":{"content":"Hi"}}]}\n', 'data: {"choices":[{"delta":{"content":" there"}}]}\n', 'data: {"usage":{"prompt_tokens":3,"completion_tokens":2},"choices":[]}\n', "data: [DONE]\n"]); }) as any;
    const p = new OpenAICompatProvider({ baseUrl: "http://x/v1/", apiKey: "k", model: "m", fetch: f });
    const cs = await collect(p.stream([{ role: "user", content: "yo" }], [{ name: "t", description: "d", parameters: { type: "object" } }]));
    expect(text(cs)).toBe("Hi there");
    expect(cs.at(-1)).toEqual({ type: "done", usage: { promptTokens: 3, completionTokens: 2 } });
    expect(req.url).toBe("http://x/v1/chat/completions");
    expect(req.init.headers.authorization).toBe("Bearer k");
    expect(req.body.tools[0].function.name).toBe("t");
  });
  test("assembles fragmented tool calls and serialises prior tool history", async () => {
    let body: any;
    const f = (async (_u: string, init: any) => { body = JSON.parse(init.body);
      return sse(['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"fs.read","arguments":"{\\"pa"}}]}}]}\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a\\"}"}}]}}]}\n', "data: [DONE]\n"]); }) as any;
    const p = new OpenAICompatProvider({ baseUrl: "http://x", model: "m", fetch: f });
    const cs = await collect(p.stream([
      { role: "assistant", content: "", toolCalls: [{ id: "p", name: "n", args: { a: 1 } }] },
      { role: "tool", content: "r", toolCallId: "p" }]));
    expect((cs[0] as any).call).toEqual({ id: "c1", name: "fs.read", args: { path: "a" } });
    expect(body.messages[0].tool_calls[0].function.arguments).toBe('{"a":1}');
    expect(body.messages[1].tool_call_id).toBe("p");
  });
  test("throws ProviderError on HTTP failure, bad tool JSON, and missing body", async () => {
    const mk = (f: any) => new OpenAICompatProvider({ baseUrl: "http://x", model: "m", fetch: f });
    await expect(collect(mk(async () => new Response("nope", { status: 429 })).stream([]))).rejects.toBeInstanceOf(ProviderError);
    await expect(collect(mk(async () => ({ ok: true, body: null })).stream([]))).rejects.toThrow(/no body/);
    const bad = mk(async () => sse(['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"x","arguments":"{oops"}}]}}]}\n', "data: [DONE]\n"]));
    await expect(collect(bad.stream([]))).rejects.toThrow(/invalid JSON/);
  });
  test("stream ending without [DONE] still finishes; skips junk lines", async () => {
    const p = new OpenAICompatProvider({ baseUrl: "http://x", model: "m", fetch: (async () => sse([": keepalive\n", "data: notjson\n", 'data: {"choices":[{"delta":{"content":"ok"}}]}\n']) ) as any });
    const cs = await collect(p.stream([]));
    expect(text(cs)).toBe("ok"); expect(cs.at(-1)?.type).toBe("done");
  });
});
