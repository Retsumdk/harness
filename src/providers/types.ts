import type { ToolCall } from "../store/types";

export interface ChatMessage { role: "system" | "user" | "assistant" | "tool"; content: string; toolCalls?: ToolCall[]; toolCallId?: string }
export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }
export type Chunk =
  | { type: "token"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "done"; usage?: { promptTokens: number; completionTokens: number } };

export interface StreamOptions { model?: string; signal?: AbortSignal }

export interface Provider {
  id: string;
  stream(messages: ChatMessage[], tools?: ToolSpec[], opts?: StreamOptions): AsyncIterable<Chunk>;
}

export class ProviderError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
