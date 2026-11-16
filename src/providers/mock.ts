import type { ChatMessage, Chunk, Provider, StreamOptions, ToolSpec } from "./types";

const words = (s: string) => s.split(/(\s+)/).filter(Boolean);

/** Deterministic provider: needs no keys, so the app and demo work offline.
 *  A user message of the form `/tool <name> {json}` makes it emit a tool call;
 *  after a tool result it summarises that result; otherwise it echoes. */
export class MockProvider implements Provider {
  id = "mock";
  constructor(private delayMs = 0) {}

  async *stream(messages: ChatMessage[], tools: ToolSpec[] = [], opts: StreamOptions = {}): AsyncIterable<Chunk> {
    const last = messages[messages.length - 1];
    let reply: string;
    if (last?.role === "tool") {
      reply = `Tool result: ${last.content}`;
    } else {
      const text = last?.content ?? "";
      const m = /^\/tool\s+(\S+)\s*(\{.*\})?$/s.exec(text.trim());
      if (m) {
        if (!tools.some((t) => t.name === m[1])) {
          reply = `I don't have a tool called "${m[1]}".`;
        } else {
          let args: Record<string, unknown> = {};
          try { args = m[2] ? JSON.parse(m[2]) : {}; } catch { args = {}; }
          yield { type: "tool_call", call: { id: `call_${messages.length}`, name: m[1], args } };
          yield { type: "done", usage: { promptTokens: text.length, completionTokens: 0 } };
          return;
        }
      } else {
        reply = text ? `You said: ${text}` : "Say something and I will reply.";
      }
    }
    let n = 0;
    for (const w of words(reply)) {
      if (opts.signal?.aborted) return;
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      n++;
      yield { type: "token", text: w };
    }
    yield { type: "done", usage: { promptTokens: messages.reduce((a, x) => a + x.content.length, 0), completionTokens: n } };
  }
}
