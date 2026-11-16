/**
 * A Store that survives a reload in a browser tab. The whole dataset is one JSON
 * document in localStorage: for a demo's handful of agents and conversations that
 * is smaller and faster than an IndexedDB round trip per write, and it keeps the
 * Store interface synchronous underneath the promises.
 *
 * When storage is unavailable (private mode, disabled cookies) it degrades to a
 * plain in-memory store instead of throwing — the app still works for the session.
 */
import { type Conversation, type Message, type Store, NotFoundError, newId } from "../store/types";
import type { AgentDefinition, AgentPatch, AgentRecord, AgentRun, RunPatch, RunRecord } from "../agents/types";
import type { PluginRecord } from "../plugins/types";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface Snapshot {
  version: 1;
  conversations: Conversation[];
  messages: Record<string, Message[]>;
  settings: Record<string, string>;
  agents: AgentDefinition[];
  runs: AgentRun[];
  plugins: PluginRecord[];
}

const emptySnapshot = (): Snapshot => ({
  version: 1, conversations: [], messages: {}, settings: {}, agents: [], runs: [], plugins: [],
});

const clone = <T>(v: T): T => (typeof structuredClone === "function" ? structuredClone(v) : (JSON.parse(JSON.stringify(v)) as T));

export class PersistentStore implements Store {
  private data: Snapshot;
  private tick = 0;

  constructor(private storage: StorageLike | null, private key = "harness.demo.v1") {
    this.data = this.load();
  }

  private now(): number {
    return Date.now() * 1000 + (this.tick++ % 1000);
  }

  private load(): Snapshot {
    if (!this.storage) return emptySnapshot();
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) return emptySnapshot();
      const parsed = JSON.parse(raw) as Snapshot;
      if (parsed?.version !== 1) return emptySnapshot();
      return { ...emptySnapshot(), ...parsed };
    } catch {
      return emptySnapshot();
    }
  }

  /** Writes the whole snapshot. Called after every mutation so a reload restores it. */
  private flush(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(this.key, JSON.stringify(this.data));
    } catch {
      // Quota or a disabled store: keep going in memory rather than losing the click.
      this.storage = null;
    }
  }

  /** Wipes the saved demo so the next boot seeds a clean workspace. */
  reset(): void {
    this.data = emptySnapshot();
    this.flush();
  }

  async createConversation(title: string, agentId?: string): Promise<Conversation> {
    const conv: Conversation = { id: newId("conv"), title, agentId, createdAt: this.now() };
    this.data.conversations.push(conv);
    this.data.messages[conv.id] = [];
    this.flush();
    return conv;
  }

  async getConversation(id: string): Promise<Conversation | undefined> {
    const conv = this.data.conversations.find((c) => c.id === id);
    return conv ? clone(conv) : undefined;
  }

  async listConversations(): Promise<Conversation[]> {
    return clone([...this.data.conversations].sort((a, b) => b.createdAt - a.createdAt));
  }

  async deleteConversation(id: string): Promise<boolean> {
    const before = this.data.conversations.length;
    this.data.conversations = this.data.conversations.filter((c) => c.id !== id);
    delete this.data.messages[id];
    this.flush();
    return this.data.conversations.length !== before;
  }

  async addMessage(m: Omit<Message, "id" | "createdAt">): Promise<Message> {
    const list = this.data.messages[m.conversationId];
    if (!list) throw new NotFoundError(`conversation ${m.conversationId} not found`);
    const msg: Message = { ...clone(m), id: newId("msg"), createdAt: this.now() };
    list.push(msg);
    this.flush();
    return clone(msg);
  }

  async listMessages(conversationId: string): Promise<Message[]> {
    return clone(this.data.messages[conversationId] ?? []);
  }

  async getSetting(key: string): Promise<string | undefined> {
    return this.data.settings[key];
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.data.settings[key] = value;
    this.flush();
  }

  async createAgent(def: AgentRecord): Promise<AgentDefinition> {
    const agent: AgentDefinition = { ...clone(def), id: newId("agent"), createdAt: this.now() };
    this.data.agents.push(agent);
    this.flush();
    return clone(agent);
  }

  async getAgent(id: string): Promise<AgentDefinition | undefined> {
    const agent = this.data.agents.find((a) => a.id === id);
    return agent ? clone(agent) : undefined;
  }

  async listAgents(): Promise<AgentDefinition[]> {
    return clone([...this.data.agents].sort((a, b) => a.createdAt - b.createdAt));
  }

  async updateAgent(id: string, patch: AgentPatch): Promise<AgentDefinition | undefined> {
    const cur = this.data.agents.find((a) => a.id === id);
    if (!cur) return undefined;
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (cur as unknown as Record<string, unknown>)[k] = v;
    this.flush();
    return clone(cur);
  }

  async deleteAgent(id: string): Promise<boolean> {
    const before = this.data.agents.length;
    this.data.agents = this.data.agents.filter((a) => a.id !== id);
    this.flush();
    return this.data.agents.length !== before;
  }

  async createRun(run: RunRecord): Promise<AgentRun> {
    const rec: AgentRun = { ...clone(run), id: newId("run"), startedAt: this.now() };
    this.data.runs.push(rec);
    this.flush();
    return clone(rec);
  }

  async getRun(id: string): Promise<AgentRun | undefined> {
    const run = this.data.runs.find((r) => r.id === id);
    return run ? clone(run) : undefined;
  }

  async listRuns(agentId?: string): Promise<AgentRun[]> {
    const all = clone([...this.data.runs].sort((a, b) => a.startedAt - b.startedAt));
    return all.filter((r) => !agentId || r.agentId === agentId);
  }

  async updateRun(id: string, patch: RunPatch): Promise<AgentRun | undefined> {
    const cur = this.data.runs.find((r) => r.id === id);
    if (!cur) return undefined;
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (cur as unknown as Record<string, unknown>)[k] = v;
    this.flush();
    return clone(cur);
  }

  async upsertPlugin(rec: PluginRecord): Promise<PluginRecord> {
    const i = this.data.plugins.findIndex((p) => p.id === rec.id);
    if (i === -1) this.data.plugins.push(clone(rec));
    else this.data.plugins[i] = clone(rec);
    this.flush();
    return clone(rec);
  }

  async getPlugin(id: string): Promise<PluginRecord | undefined> {
    const rec = this.data.plugins.find((p) => p.id === id);
    return rec ? clone(rec) : undefined;
  }

  async listPlugins(): Promise<PluginRecord[]> {
    return clone([...this.data.plugins].sort((a, b) => a.installedAt - b.installedAt));
  }

  async deletePlugin(id: string): Promise<boolean> {
    const before = this.data.plugins.length;
    this.data.plugins = this.data.plugins.filter((p) => p.id !== id);
    this.flush();
    return this.data.plugins.length !== before;
  }

  async close(): Promise<void> {}
}

/** localStorage when the browser allows it, otherwise null (memory only). */
export function browserStorage(): StorageLike | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const probe = "harness.probe";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}
