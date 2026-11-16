import type { AgentDefinition, AgentPatch, AgentRecord, AgentRun, RunPatch, RunRecord } from "../agents/types";
import type { PluginRecord } from "../plugins/types";

export type Role = "system" | "user" | "assistant" | "tool";

export interface Conversation { id: string; title: string; agentId?: string; createdAt: number }
export interface ToolCall { id: string; name: string; args: Record<string, unknown> }
export interface Message {
  id: string; conversationId: string; role: Role; content: string; toolCalls?: ToolCall[]; createdAt: number;
}

export interface Store {
  createConversation(title: string, agentId?: string): Promise<Conversation>;
  getConversation(id: string): Promise<Conversation | undefined>;
  listConversations(): Promise<Conversation[]>;
  deleteConversation(id: string): Promise<boolean>;
  addMessage(m: Omit<Message, "id" | "createdAt">): Promise<Message>;
  listMessages(conversationId: string): Promise<Message[]>;
  getSetting(key: string): Promise<string | undefined>;
  setSetting(key: string, value: string): Promise<void>;

  createAgent(def: AgentRecord): Promise<AgentDefinition>;
  getAgent(id: string): Promise<AgentDefinition | undefined>;
  listAgents(): Promise<AgentDefinition[]>;
  updateAgent(id: string, patch: AgentPatch): Promise<AgentDefinition | undefined>;
  deleteAgent(id: string): Promise<boolean>;

  createRun(run: RunRecord): Promise<AgentRun>;
  getRun(id: string): Promise<AgentRun | undefined>;
  listRuns(agentId?: string): Promise<AgentRun[]>;
  updateRun(id: string, patch: RunPatch): Promise<AgentRun | undefined>;

  upsertPlugin(rec: PluginRecord): Promise<PluginRecord>;
  getPlugin(id: string): Promise<PluginRecord | undefined>;
  listPlugins(): Promise<PluginRecord[]>;
  deletePlugin(id: string): Promise<boolean>;

  close(): Promise<void>;
}

export class NotFoundError extends Error {
  code = "not_found" as const;
}

export const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
