import { ChatService, MemoryStore, MockProvider, ToolRegistry } from "../src";
import { createApp } from "../src/server/app";

export const TOKEN = "test-token-123";
export function build() {
  const store = new MemoryStore();
  const chat = new ChatService(store, new Map([["mock", new MockProvider()]]), new ToolRegistry());
  const app = createApp({ token: TOKEN, store, chat });
  const auth = { authorization: `Bearer ${TOKEN}` };
  return { app, store, auth };
}
