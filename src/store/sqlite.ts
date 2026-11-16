import { Database } from "bun:sqlite";
import { type Conversation, type Message, type Store, NotFoundError, newId } from "./types";
import type { AgentDefinition, AgentPatch, AgentRecord, AgentRun, RunPatch, RunRecord } from "../agents/types";
import type { PluginRecord } from "../plugins/types";

export class SqliteStore implements Store {
  private db: Database;
  private seq = 0;

  constructor(path = ":memory:") {
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, title TEXT NOT NULL, agent_id TEXT, created_at INTEGER NOT NULL, seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT NOT NULL, tool_calls TEXT, created_at INTEGER NOT NULL, seq INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, seq);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, name TEXT NOT NULL, system_prompt TEXT NOT NULL, provider TEXT NOT NULL,
        model TEXT, tools TEXT NOT NULL, max_steps INTEGER NOT NULL, max_tokens INTEGER NOT NULL, parent_id TEXT,
        created_at INTEGER NOT NULL, seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, parent_run_id TEXT, status TEXT NOT NULL,
        input TEXT NOT NULL, output TEXT NOT NULL, steps TEXT NOT NULL, tokens_used INTEGER NOT NULL, error TEXT,
        started_at INTEGER NOT NULL, ended_at INTEGER, seq INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_id, seq);
      CREATE TABLE IF NOT EXISTS plugins(id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, manifest TEXT NOT NULL,
        config TEXT NOT NULL, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, seq INTEGER NOT NULL);
    `);
    const row = this.db.query(`SELECT MAX(s) AS m FROM (
      SELECT MAX(seq) s FROM conversations UNION ALL SELECT MAX(seq) FROM messages
      UNION ALL SELECT MAX(seq) FROM agents UNION ALL SELECT MAX(seq) FROM runs
      UNION ALL SELECT MAX(seq) FROM plugins)`).get() as { m: number | null };
    this.seq = row.m ?? 0;
  }

  async createConversation(title: string, agentId?: string): Promise<Conversation> {
    const c: Conversation = { id: newId("conv"), title, agentId, createdAt: Date.now() };
    this.db.query("INSERT INTO conversations VALUES (?,?,?,?,?)").run(c.id, title, agentId ?? null, c.createdAt, ++this.seq);
    return c;
  }
  async getConversation(id: string) {
    const r = this.db.query("SELECT * FROM conversations WHERE id=?").get(id) as any;
    return r ? this.toConv(r) : undefined;
  }
  async listConversations() {
    return (this.db.query("SELECT * FROM conversations ORDER BY seq DESC").all() as any[]).map(this.toConv);
  }
  async deleteConversation(id: string) {
    return this.db.query("DELETE FROM conversations WHERE id=?").run(id).changes > 0;
  }
  async addMessage(m: Omit<Message, "id" | "createdAt">): Promise<Message> {
    if (!(await this.getConversation(m.conversationId))) throw new NotFoundError(`conversation ${m.conversationId} not found`);
    const msg: Message = { ...m, id: newId("msg"), createdAt: Date.now() };
    this.db.query("INSERT INTO messages VALUES (?,?,?,?,?,?,?)").run(
      msg.id, msg.conversationId, msg.role, msg.content, m.toolCalls ? JSON.stringify(m.toolCalls) : null, msg.createdAt, ++this.seq);
    return msg;
  }
  async listMessages(conversationId: string) {
    return (this.db.query("SELECT * FROM messages WHERE conversation_id=? ORDER BY seq").all(conversationId) as any[]).map((r) => ({
      id: r.id, conversationId: r.conversation_id, role: r.role, content: r.content,
      toolCalls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined, createdAt: r.created_at,
    }));
  }
  async getSetting(key: string) {
    return (this.db.query("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | null)?.value;
  }
  async setSetting(key: string, value: string) {
    this.db.query("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  async createAgent(def: AgentRecord): Promise<AgentDefinition> {
    const agent: AgentDefinition = { ...def, id: newId("agent"), createdAt: Date.now() };
    this.db.query("INSERT INTO agents VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
      agent.id, agent.name, agent.systemPrompt, agent.provider, agent.model ?? null, JSON.stringify(agent.tools),
      agent.maxSteps, agent.maxTokens, agent.parentId ?? null, agent.createdAt, ++this.seq);
    return agent;
  }
  async getAgent(id: string) {
    const r = this.db.query("SELECT * FROM agents WHERE id=?").get(id) as any;
    return r ? this.toAgent(r) : undefined;
  }
  async listAgents() {
    return (this.db.query("SELECT * FROM agents ORDER BY seq").all() as any[]).map(this.toAgent);
  }
  async updateAgent(id: string, patch: AgentPatch) {
    const cur = await this.getAgent(id);
    if (!cur) return undefined;
    const next: AgentDefinition = { ...cur };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (next as any)[k] = v;
    this.db.query("UPDATE agents SET name=?, system_prompt=?, provider=?, model=?, tools=?, max_steps=?, max_tokens=?, parent_id=? WHERE id=?").run(
      next.name, next.systemPrompt, next.provider, next.model ?? null, JSON.stringify(next.tools),
      next.maxSteps, next.maxTokens, next.parentId ?? null, id);
    return next;
  }
  async deleteAgent(id: string) {
    return this.db.query("DELETE FROM agents WHERE id=?").run(id).changes > 0;
  }

  async createRun(run: RunRecord): Promise<AgentRun> {
    const rec: AgentRun = { ...run, id: newId("run"), startedAt: Date.now() };
    this.db.query("INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
      rec.id, rec.agentId, rec.parentRunId ?? null, rec.status, rec.input, rec.output,
      JSON.stringify(rec.steps), rec.tokensUsed, rec.error ?? null, rec.startedAt, rec.endedAt ?? null, ++this.seq);
    return rec;
  }
  async getRun(id: string) {
    const r = this.db.query("SELECT * FROM runs WHERE id=?").get(id) as any;
    return r ? this.toRun(r) : undefined;
  }
  async listRuns(agentId?: string) {
    const rows = agentId
      ? this.db.query("SELECT * FROM runs WHERE agent_id=? ORDER BY seq").all(agentId)
      : this.db.query("SELECT * FROM runs ORDER BY seq").all();
    return (rows as any[]).map(this.toRun);
  }
  async updateRun(id: string, patch: RunPatch) {
    const cur = await this.getRun(id);
    if (!cur) return undefined;
    const next: AgentRun = { ...cur };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (next as any)[k] = v;
    this.db.query("UPDATE runs SET status=?, output=?, steps=?, tokens_used=?, error=?, ended_at=? WHERE id=?").run(
      next.status, next.output, JSON.stringify(next.steps), next.tokensUsed, next.error ?? null, next.endedAt ?? null, id);
    return next;
  }

  async upsertPlugin(rec: PluginRecord) {
    this.db.query(`INSERT INTO plugins VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, manifest=excluded.manifest, config=excluded.config,
        updated_at=excluded.updated_at`).run(
      rec.id, rec.enabled ? 1 : 0, JSON.stringify(rec.manifest), JSON.stringify(rec.config), rec.installedAt, rec.updatedAt, ++this.seq);
    return rec;
  }
  async getPlugin(id: string) {
    const r = this.db.query("SELECT * FROM plugins WHERE id=?").get(id) as any;
    return r ? this.toPlugin(r) : undefined;
  }
  async listPlugins() {
    return (this.db.query("SELECT * FROM plugins ORDER BY seq").all() as any[]).map(this.toPlugin);
  }
  async deletePlugin(id: string) {
    return this.db.query("DELETE FROM plugins WHERE id=?").run(id).changes > 0;
  }

  async close() { this.db.close(); }
  private toConv = (r: any): Conversation => ({ id: r.id, title: r.title, agentId: r.agent_id ?? undefined, createdAt: r.created_at });
  private toAgent = (r: any): AgentDefinition => ({
    id: r.id, name: r.name, systemPrompt: r.system_prompt, provider: r.provider, model: r.model ?? undefined,
    tools: JSON.parse(r.tools), maxSteps: r.max_steps, maxTokens: r.max_tokens, parentId: r.parent_id ?? undefined, createdAt: r.created_at,
  });
  private toPlugin = (r: any): PluginRecord => ({
    id: r.id, enabled: Boolean(r.enabled), manifest: JSON.parse(r.manifest), config: JSON.parse(r.config),
    installedAt: r.installed_at, updatedAt: r.updated_at,
  });
  private toRun = (r: any): AgentRun => ({
    id: r.id, agentId: r.agent_id, parentRunId: r.parent_run_id ?? undefined, status: r.status, input: r.input,
    output: r.output, steps: JSON.parse(r.steps), tokensUsed: r.tokens_used, error: r.error ?? undefined,
    startedAt: r.started_at, endedAt: r.ended_at ?? undefined,
  });
}
