/** Typed HTTP client for the HARNESS API. Everything the UI needs lives here so the
 *  components stay presentational and the client can be tested with a fake fetch. */

export interface Conversation {
  id: string;
  title: string;
  agentId?: string;
  createdAt: number;
}

export interface Message {
  id: string;
  conversationId: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: { id: string; name: string; args: Record<string, unknown> }[];
  createdAt: number;
}

export interface Agent {
  id: string;
  name: string;
  systemPrompt: string;
  provider: string;
  model?: string;
  tools: string[];
  maxSteps: number;
  maxTokens: number;
  parentId?: string;
  createdAt: number;
}

export type RunStatus = "running" | "succeeded" | "failed" | "cancelled" | "budget_exceeded";

export type RunStep =
  | { index: number; kind: "assistant"; text: string; tokens: number }
  | { index: number; kind: "tool"; tool: string; args: Record<string, unknown>; result?: unknown; error?: string };

export interface AgentRun {
  id: string;
  agentId: string;
  parentRunId?: string;
  status: RunStatus;
  input: string;
  output: string;
  steps: RunStep[];
  tokensUsed: number;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export type RunSummary = Pick<AgentRun, "id" | "agentId" | "status" | "input" | "startedAt" | "endedAt" | "tokensUsed">;

export interface FileEntry {
  name: string;
  kind: "file" | "dir";
  path: string;
  size?: number;
}

export type FileResponse =
  | { type: "dir"; path: string; entries: FileEntry[] }
  | { type: "file"; path: string; content: string; size: number };

export interface SearchHit { path: string; line: number; text: string }

export interface PluginConfigField {
  name: string;
  /** Manifests do not carry display labels; the UI derives one from the name. */
  label?: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  secret?: boolean;
  description?: string;
}

export interface PluginView {
  id: string;
  name: string;
  version: string;
  description: string;
  permissions: string[];
  config: PluginConfigField[];
  configValues: Record<string, string>;
  missingRequired: string[];
  tools: string[];
  installed: boolean;
  enabled: boolean;
  updatedAt: number;
}

export interface ModuleView {
  id: string;
  version?: string;
  requires: string[];
  state: "registered" | "running" | "stopped";
  dependants: string[];
  missing: string[];
}

export interface SettingsView {
  settings: { provider: string; model: string };
  providers: string[];
  defaultProvider: string;
  tools: string[];
  workspace: string;
  version: string;
}

/** What the Settings page needs: the saved defaults plus the facts about this instance. */
export interface SettingsPayload {
  settings: { provider: string; model: string };
  providers: string[];
  defaultProvider: string;
  tools: string[];
  workspace: string;
  version: string;
  modules: ModuleView[];
}

export interface SettingsPayload extends SettingsView {
  modules: ModuleView[];
}

export type ChatEvent =
  | { type: "token"; text: string }
  | { type: "tool_call"; call: { id: string; name: string; args: Record<string, unknown> } }
  | { type: "tool_result"; id: string; result?: unknown; error?: string }
  | { type: "done"; conversationId: string }
  | { type: "error"; code: string; message: string };

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = "access token rejected") {
    super(401, "unauthorized", message);
  }
}

export class NetworkError extends Error {}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  token?: string | null;
}

/** Splits an SSE byte stream into named events. Exported because it is the one piece
 *  of transport logic worth testing on its own. */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: unknown) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut = buffer.indexOf("\n\n");
    while (cut !== -1) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      if (data.length) {
        const raw = data.join("\n");
        let parsed: unknown = raw;
        try { parsed = JSON.parse(raw); } catch { /* keep the raw string */ }
        onEvent(event, parsed);
      }
      cut = buffer.indexOf("\n\n");
    }
  }
}

export class HarnessApi {
  private baseUrl: string;
  private f: FetchLike;
  private token: string | null;

  constructor(opts: ApiOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "").replace(/\/$/, "");
    this.f = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.token = opts.token ?? null;
  }

  setToken(token: string | null): void { this.token = token; }
  getToken(): string | null { return this.token; }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { accept: "application/json", ...extra };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  private async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await this.f(`${this.baseUrl}${path}`, {
        method,
        signal,
        headers: this.headers(body === undefined ? {} : { "content-type": "application/json" }),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e;
      throw new NetworkError(`cannot reach the harness server (${(e as Error).message})`);
    }
    if (res.status === 401) throw new UnauthorizedError();
    const text = await res.text();
    let parsed: any = undefined;
    if (text) { try { parsed = JSON.parse(text); } catch { parsed = undefined; } }
    if (!res.ok) {
      const envelope = parsed?.error;
      throw new ApiError(res.status, envelope?.code ?? "http_error", envelope?.message ?? `${res.status} ${res.statusText}`);
    }
    return parsed as T;
  }

  health(): Promise<{ ok: boolean; version: string; modules: unknown[] }> {
    return this.request("GET", "/health");
  }

  settings(): Promise<SettingsView> {
    return this.request("GET", "/api/settings");
  }

  saveSettings(patch: { provider?: string; model?: string }): Promise<{ settings: { provider: string; model: string } }> {
    return this.request("PUT", "/api/settings", patch);
  }

  async listConversations(): Promise<Conversation[]> {
    return (await this.request<{ conversations: Conversation[] }>("GET", "/api/conversations")).conversations;
  }

  getConversation(id: string): Promise<{ conversation: Conversation; messages: Message[] }> {
    return this.request("GET", `/api/conversations/${encodeURIComponent(id)}`);
  }

  deleteConversation(id: string): Promise<{ ok: boolean }> {
    return this.request("DELETE", `/api/conversations/${encodeURIComponent(id)}`);
  }

  /** Streams one assistant turn. Resolves with the conversation id once done. */
  async chat(
    input: { message: string; conversationId?: string; provider?: string; model?: string },
    handlers: { onEvent: (event: ChatEvent) => void; signal?: AbortSignal },
  ): Promise<string | undefined> {
    let res: Response;
    try {
      res = await this.f(`${this.baseUrl}/api/chat`, {
        method: "POST",
        signal: handlers.signal,
        headers: this.headers({ "content-type": "application/json", accept: "text/event-stream" }),
        body: JSON.stringify(input),
      });
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e;
      throw new NetworkError(`cannot reach the harness server (${(e as Error).message})`);
    }
    if (res.status === 401) throw new UnauthorizedError();
    if (!res.ok || !res.body) {
      const text = await res.text();
      let message = `${res.status} ${res.statusText}`;
      try { message = JSON.parse(text)?.error?.message ?? message; } catch { /* keep the status text */ }
      throw new ApiError(res.status, "chat_failed", message);
    }
    let conversationId: string | undefined;
    await readSse(res.body, (event, data) => {
      const payload = data as ChatEvent;
      if (payload && typeof payload === "object" && "type" in payload && payload.type !== event) {
        payload.type = event as ChatEvent["type"];
      }
      if (event === "done") conversationId = (payload as { conversationId: string }).conversationId;
      handlers.onEvent(payload);
    });
    return conversationId;
  }

  files(path = "."): Promise<FileResponse> {
    return this.request("GET", `/api/files?path=${encodeURIComponent(path)}`);
  }

  writeFile(path: string, content: string): Promise<{ ok: boolean; path: string; size: number }> {
    return this.request("PUT", `/api/files?path=${encodeURIComponent(path)}`, { content });
  }

  deleteFile(path: string): Promise<{ ok: boolean }> {
    return this.request("DELETE", `/api/files?path=${encodeURIComponent(path)}`);
  }

  async searchFiles(q: string): Promise<SearchHit[]> {
    return (await this.request<{ results: SearchHit[] }>("GET", `/api/files/search?q=${encodeURIComponent(q)}`)).results;
  }

  async listAgents(): Promise<Agent[]> {
    return (await this.request<{ agents: Agent[] }>("GET", "/api/agents")).agents;
  }

  async getAgent(id: string): Promise<Agent> {
    return (await this.request<{ agent: Agent }>("GET", `/api/agents/${encodeURIComponent(id)}`)).agent;
  }

  async createAgent(input: Partial<Agent> & { name: string }): Promise<Agent> {
    return (await this.request<{ agent: Agent }>("POST", "/api/agents", input)).agent;
  }

  async updateAgent(id: string, patch: Partial<Agent>): Promise<Agent> {
    return (await this.request<{ agent: Agent }>("PATCH", `/api/agents/${encodeURIComponent(id)}`, patch)).agent;
  }

  deleteAgent(id: string): Promise<{ ok: boolean }> {
    return this.request("DELETE", `/api/agents/${encodeURIComponent(id)}`);
  }

  async listRuns(agentId?: string): Promise<RunSummary[]> {
    const q = agentId ? `?agentId=${encodeURIComponent(agentId)}` : "";
    return (await this.request<{ runs: RunSummary[] }>("GET", `/api/runs${q}`)).runs;
  }

  async startRun(agentId: string, input: string): Promise<string> {
    return (await this.request<{ runId: string }>("POST", `/api/agents/${encodeURIComponent(agentId)}/runs`, { input })).runId;
  }

  async getRun(id: string): Promise<AgentRun> {
    return (await this.request<{ run: AgentRun }>("GET", `/api/runs/${encodeURIComponent(id)}`)).run;
  }

  async cancelRun(id: string): Promise<boolean> {
    return (await this.request<{ cancelled: boolean }>("POST", `/api/runs/${encodeURIComponent(id)}/cancel`)).cancelled;
  }

  streamRunUrl(id: string): string {
    return `${this.baseUrl}/api/runs/${encodeURIComponent(id)}/stream`;
  }

  /** Opens the run's SSE feed. Returns a function that aborts it. */
  streamRun(
    id: string,
    handlers: { onEvent: (event: string, data: unknown) => void; onOpen?: () => void; onClose?: (reason: string) => void },
  ): () => void {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await this.f(this.streamRunUrl(id), {
          headers: this.headers({ accept: "text/event-stream" }),
          signal: controller.signal,
        });
        if (res.status === 401) throw new UnauthorizedError();
        if (!res.ok || !res.body) throw new ApiError(res.status, "stream_failed", `run stream returned ${res.status}`);
        handlers.onOpen?.();
        await readSse(res.body, handlers.onEvent);
        handlers.onClose?.("closed");
      } catch (e) {
        if (controller.signal.aborted) return;
        handlers.onClose?.((e as Error).message);
      }
    })();
    return () => controller.abort();
  }

  async listPlugins(): Promise<PluginView[]> {
    return (await this.request<{ plugins: PluginView[] }>("GET", "/api/plugins")).plugins;
  }

  async enablePlugin(id: string): Promise<PluginView> {
    return (await this.request<{ plugin: PluginView }>("POST", `/api/plugins/${encodeURIComponent(id)}/enable`)).plugin;
  }

  async disablePlugin(id: string): Promise<PluginView> {
    return (await this.request<{ plugin: PluginView }>("POST", `/api/plugins/${encodeURIComponent(id)}/disable`)).plugin;
  }

  async configurePlugin(id: string, config: Record<string, unknown>): Promise<PluginView> {
    return (await this.request<{ plugin: PluginView }>("PUT", `/api/plugins/${encodeURIComponent(id)}/config`, config)).plugin;
  }

  uninstallPlugin(id: string): Promise<{ ok: boolean }> {
    return this.request("DELETE", `/api/plugins/${encodeURIComponent(id)}`);
  }

  async listModules(): Promise<ModuleView[]> {
    return (await this.request<{ modules: ModuleView[] }>("GET", "/api/modules")).modules;
  }

  async enableModule(id: string): Promise<ModuleView> {
    return (await this.request<{ module: ModuleView }>("POST", `/api/modules/${encodeURIComponent(id)}/enable`)).module;
  }

  async disableModule(id: string): Promise<ModuleView> {
    return (await this.request<{ module: ModuleView }>("POST", `/api/modules/${encodeURIComponent(id)}/disable`)).module;
  }
}

/** One sentence a person can act on. Never a stack trace. */
export function describeError(e: unknown): string {
  if (e instanceof UnauthorizedError) return "That access token was rejected. Sign in again with the token from HARNESS_TOKEN.";
  if (e instanceof ApiError) return e.message;
  if (e instanceof NetworkError) return e.message;
  if (e instanceof Error) {
    if (/abort/i.test(e.message)) return "Request cancelled.";
    return e.message;
  }
  return "Something went wrong.";
}
