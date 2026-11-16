import { AgentService, ChatService, MemoryStore, MockProvider, ToolRegistry, type Provider } from "../src";
import { createApp } from "../src/server/app";

export const TOKEN = "test-token-123";

export function toolCall(name: string, args: Record<string, unknown>): string {
  return `/tool ${name} ${JSON.stringify(args)}`;
}

export function buildAgents(opts: { provider?: Provider } = {}) {
  const store = new MemoryStore();
  const tools = new ToolRegistry();
  tools.register({
    name: "echo",
    description: "Echo the x argument",
    schema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
    run: (a) => `got ${a.x}`,
  });
  const provider = opts.provider ?? new MockProvider();
  const providers = new Map<string, Provider>([[provider.id, provider]]);
  const agents = new AgentService({ store, providers, tools, defaultProvider: provider.id });
  return { store, tools, providers, agents, providerId: provider.id };
}

export function buildApp(opts: { provider?: Provider } = {}) {
  const ctx = buildAgents(opts);
  const chat = new ChatService(ctx.store, ctx.providers, ctx.tools, ctx.providerId);
  const app = createApp({ store: ctx.store, chat, agents: ctx.agents, token: TOKEN });
  const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  return { ...ctx, app, auth };
}
