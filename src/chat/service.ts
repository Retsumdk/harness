import type { Store, ToolCall } from "../store/types";
import type { ChatMessage, Provider, ToolSpec } from "../providers/types";
import { ProviderError } from "../providers/types";
import { NotFoundError } from "../store/types";
import { ToolError, type ToolRegistry } from "../tools/registry";

export type ChatEvent =
  | { type: "token"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; id: string; result?: unknown; error?: string }
  | { type: "done"; conversationId: string }
  | { type: "error"; code: string; message: string };

export interface ChatOptions { conversationId?: string; message: string; model?: string; signal?: AbortSignal; maxToolRounds?: number }

export class ChatService {
  constructor(private store: Store, private providers: Map<string, Provider>, private tools: ToolRegistry, private defaultProvider = "mock") {}

  providerIds(): string[] { return [...this.providers.keys()]; }

  /** The provider used when a request does not name one. */
  defaultProviderId(): string { return this.defaultProvider; }

  async *send(opts: ChatOptions & { provider?: string }): AsyncGenerator<ChatEvent> {
    const provider = this.providers.get(opts.provider ?? this.defaultProvider);
    if (!provider) { yield { type: "error", code: "unknown_provider", message: `unknown provider "${opts.provider}"` }; return; }
    let conv = opts.conversationId ? await this.store.getConversation(opts.conversationId) : undefined;
    if (opts.conversationId && !conv) throw new NotFoundError(`conversation "${opts.conversationId}" not found`);
    if (!conv) conv = await this.store.createConversation(opts.message.slice(0, 48));
    await this.store.addMessage({ conversationId: conv.id, role: "user", content: opts.message });
    const specs: ToolSpec[] = this.tools.list().map((t) => ({ name: t.name, description: t.description, parameters: t.schema as unknown as Record<string, unknown> }));
    const maxRounds = opts.maxToolRounds ?? 5;
    try {
      for (let round = 0; round <= maxRounds; round++) {
        const history = await this.store.listMessages(conv.id);
        const msgs: ChatMessage[] = history.map((m) => ({ role: m.role, content: m.content, toolCalls: m.toolCalls, toolCallId: m.role === "tool" ? m.id : undefined }));
        let text = ""; const calls: ToolCall[] = [];
        for await (const c of provider.stream(msgs, specs, { model: opts.model, signal: opts.signal })) {
          if (c.type === "token") { text += c.text; yield { type: "token", text: c.text }; }
          else if (c.type === "tool_call") { calls.push(c.call); yield { type: "tool_call", call: c.call }; }
        }
        await this.store.addMessage({ conversationId: conv.id, role: "assistant", content: text, toolCalls: calls.length ? calls : undefined });
        if (!calls.length) break;
        if (round === maxRounds) { yield { type: "error", code: "tool_loop_limit", message: `stopped after ${maxRounds} tool rounds` }; return; }
        for (const call of calls) {
          let content: string;
          try {
            const result = await this.tools.call(call.name, call.args);
            content = typeof result === "string" ? result : JSON.stringify(result);
            yield { type: "tool_result", id: call.id, result };
          } catch (e) {
            const msg = e instanceof ToolError ? `${e.code}: ${e.message}` : (e as Error).message;
            content = `error: ${msg}`;
            yield { type: "tool_result", id: call.id, error: msg };
          }
          await this.store.addMessage({ conversationId: conv.id, role: "tool", content });
        }
      }
    } catch (e) {
      const status = e instanceof ProviderError ? e.status : 500;
      yield { type: "error", code: status === 429 ? "rate_limited" : "provider_error", message: (e as Error).message };
      return;
    }
    yield { type: "done", conversationId: conv.id };
  }
}
