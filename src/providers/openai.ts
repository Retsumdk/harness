import { type ChatMessage, type Chunk, type Provider, ProviderError, type StreamOptions, type ToolSpec } from "./types";

export interface OpenAIOptions { id?: string; baseUrl: string; apiKey?: string; model: string; fetch?: typeof fetch }

const toWire = (m: ChatMessage) => {
  if (m.role === "tool") return { role: "tool", content: m.content, tool_call_id: m.toolCallId };
  if (m.toolCalls?.length)
    return { role: "assistant", content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) };
  return { role: m.role, content: m.content };
};

/** Any OpenAI Chat Completions compatible endpoint (hosted or local). Streams SSE. */
export class OpenAICompatProvider implements Provider {
  id: string;
  private f: typeof fetch;
  constructor(private o: OpenAIOptions) {
    this.id = o.id ?? "openai-compat";
    this.f = o.fetch ?? fetch;
  }

  async *stream(messages: ChatMessage[], tools: ToolSpec[] = [], opts: StreamOptions = {}): AsyncIterable<Chunk> {
    const body: Record<string, unknown> = { model: opts.model ?? this.o.model, stream: true, stream_options: { include_usage: true }, messages: messages.map(toWire) };
    if (tools.length) body.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    const res = await this.f(`${this.o.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST", signal: opts.signal,
      headers: { "content-type": "application/json", ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}) },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new ProviderError(res.status, `provider ${this.id} returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    if (!res.body) throw new ProviderError(502, "provider returned no body");

    const pending = new Map<number, { id: string; name: string; args: string }>();
    let usage: { promptTokens: number; completionTokens: number } | undefined;
    const dec = new TextDecoder();
    let buf = "";
    const flushCalls = function* (): Generator<Chunk> {
      for (const [, c] of [...pending].sort((a, b) => a[0] - b[0])) {
        let args: Record<string, unknown> = {};
        try { args = c.args ? JSON.parse(c.args) : {}; } catch { throw new ProviderError(502, `tool call "${c.name}" had invalid JSON arguments`); }
        yield { type: "tool_call", call: { id: c.id, name: c.name, args } };
      }
      pending.clear();
    };

    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(part, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") { yield* flushCalls(); yield { type: "done", usage }; return; }
        let j: any;
        try { j = JSON.parse(data); } catch { continue; }
        if (j.usage) usage = { promptTokens: j.usage.prompt_tokens ?? 0, completionTokens: j.usage.completion_tokens ?? 0 };
        const d = j.choices?.[0]?.delta;
        if (d?.content) yield { type: "token", text: d.content };
        for (const tc of d?.tool_calls ?? []) {
          const cur = pending.get(tc.index ?? 0) ?? { id: "", name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          pending.set(tc.index ?? 0, cur);
        }
      }
    }
    yield* flushCalls();
    yield { type: "done", usage };
  }
}
