import { type Conversation, type Message, type Store, NotFoundError, newId } from "./types";
import type { AgentDefinition, AgentPatch, AgentRecord, AgentRun, RunPatch, RunRecord } from "../agents/types";
import type { PluginRecord } from "../plugins/types";

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryStore implements Store {
  private convs = new Map<string, Conversation>();
  private msgs = new Map<string, Message[]>();
  private settings = new Map<string, string>();
  private agents = new Map<string, AgentDefinition>();
  private runs = new Map<string, AgentRun>();
  private plugins = new Map<string, PluginRecord>();
  private tick = 0;
  private now() { return Date.now() * 1000 + (this.tick++ % 1000); }

  async createConversation(title: string, agentId?: string) {
    const c: Conversation = { id: newId("conv"), title, agentId, createdAt: this.now() };
    this.convs.set(c.id, c);
    this.msgs.set(c.id, []);
    return c;
  }
  async getConversation(id: string) { return this.convs.get(id); }
  async listConversations() { return [...this.convs.values()].sort((a, b) => b.createdAt - a.createdAt); }
  async deleteConversation(id: string) { this.msgs.delete(id); return this.convs.delete(id); }
  async addMessage(m: Omit<Message, "id" | "createdAt">) {
    const list = this.msgs.get(m.conversationId);
    if (!list) throw new NotFoundError(`conversation ${m.conversationId} not found`);
    const msg: Message = { ...m, id: newId("msg"), createdAt: this.now() };
    list.push(msg);
    return msg;
  }
  async listMessages(id: string) { return [...(this.msgs.get(id) ?? [])]; }
  async getSetting(k: string) { return this.settings.get(k); }
  async setSetting(k: string, v: string) { this.settings.set(k, v); }

  async createAgent(def: AgentRecord) {
    const agent: AgentDefinition = { ...clone(def), id: newId("agent"), createdAt: this.now() };
    this.agents.set(agent.id, agent);
    return clone(agent);
  }
  async getAgent(id: string) { const a = this.agents.get(id); return a ? clone(a) : undefined; }
  async listAgents() { return [...this.agents.values()].sort((a, b) => a.createdAt - b.createdAt).map(clone); }
  async updateAgent(id: string, patch: AgentPatch) {
    const cur = this.agents.get(id);
    if (!cur) return undefined;
    const next = { ...cur };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (next as any)[k] = v;
    this.agents.set(id, next);
    return clone(next);
  }
  async deleteAgent(id: string) { return this.agents.delete(id); }

  async createRun(run: RunRecord) {
    const rec: AgentRun = { ...clone(run), id: newId("run"), startedAt: this.now() };
    this.runs.set(rec.id, rec);
    return clone(rec);
  }
  async getRun(id: string) { const r = this.runs.get(id); return r ? clone(r) : undefined; }
  async listRuns(agentId?: string) {
    const all = [...this.runs.values()].sort((a, b) => a.startedAt - b.startedAt);
    return all.filter((r) => !agentId || r.agentId === agentId).map(clone);
  }
  async updateRun(id: string, patch: RunPatch) {
    const cur = this.runs.get(id);
    if (!cur) return undefined;
    const next = { ...cur };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (next as any)[k] = v;
    this.runs.set(id, next);
    return clone(next);
  }

  async upsertPlugin(rec: PluginRecord) {
    this.plugins.set(rec.id, clone(rec));
    return clone(rec);
  }
  async getPlugin(id: string) { const p = this.plugins.get(id); return p ? clone(p) : undefined; }
  async listPlugins() { return [...this.plugins.values()].sort((a, b) => a.installedAt - b.installedAt).map(clone); }
  async deletePlugin(id: string) { return this.plugins.delete(id); }

  async close() {}
}
