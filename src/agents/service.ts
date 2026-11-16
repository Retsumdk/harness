import type { Store, ToolCall } from "../store/types";
import type { ChatMessage, Provider, ToolSpec } from "../providers/types";
import type { ToolRegistry } from "../tools/registry";
import { ToolError } from "../tools/registry";
import {
  AgentError, MAX_SPAWN_DEPTH,
  type AgentDefinition, type AgentPatch, type AgentRun, type RunStatus, type RunStep,
} from "./types";

export interface AgentInput {
  name: string;
  systemPrompt?: string;
  provider?: string;
  model?: string;
  tools?: string[];
  maxSteps?: number;
  maxTokens?: number;
  parentId?: string;
}

export interface AgentServiceDeps {
  store: Store;
  providers: Map<string, Provider>;
  tools: ToolRegistry;
  defaultProvider?: string;
  maxSpawnDepth?: number;
  /** Names the runner itself provides; they need not exist in the tool registry. */
  builtinAgentTools?: string[];
}

export const SPAWN_TOOL = "agent.spawn";
const DEFAULT_STEPS = 8;
const DEFAULT_TOKENS = 2000;
const MAX_STEPS_CEILING = 50;
const MAX_TOKENS_CEILING = 200_000;

/** The runner's own tool: starts another agent run and waits for its result. */
const SPAWN_SPEC: ToolSpec = {
  name: SPAWN_TOOL,
  description: "Start another agent on a task and wait for its result. Nested agents are depth-limited.",
  parameters: {
    type: "object",
    properties: { agentId: { type: "string" }, input: { type: "string" } },
    required: ["agentId", "input"],
  },
};

const text = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

export class AgentService {
  private controllers = new Map<string, AbortController>();
  private readonly maxSpawnDepth: number;
  private readonly builtinTools: string[];

  constructor(private deps: AgentServiceDeps) {
    this.maxSpawnDepth = deps.maxSpawnDepth ?? MAX_SPAWN_DEPTH;
    this.builtinTools = deps.builtinAgentTools ?? [SPAWN_TOOL];
  }

  // ---- definitions -------------------------------------------------------

  private normalise(input: AgentInput, existing?: AgentDefinition): AgentDefinition {
    const merged: AgentInput = { ...(existing ?? {} as AgentInput), ...input };
    const name = merged.name;
    if (typeof name !== "string" || !name.trim()) throw new AgentError("invalid", "\"name\" must be a non-empty string");
    if (name.length > 64) throw new AgentError("invalid", "\"name\" must be 64 characters or fewer");
    const systemPrompt = merged.systemPrompt ?? "";
    if (typeof systemPrompt !== "string") throw new AgentError("invalid", "\"systemPrompt\" must be a string");
    if (systemPrompt.length > 20_000) throw new AgentError("invalid", "\"systemPrompt\" must be 20000 characters or fewer");
    const provider = merged.provider ?? this.deps.defaultProvider ?? "mock";
    if (!this.deps.providers.has(provider)) throw new AgentError("invalid", `unknown provider "${provider}"`);
    const model = merged.model;
    if (model !== undefined && (typeof model !== "string" || model.length > 120)) throw new AgentError("invalid", "\"model\" must be a string of 120 characters or fewer");
    const tools = merged.tools ?? [];
    if (!Array.isArray(tools) || tools.some((t) => typeof t !== "string"))
      throw new AgentError("invalid", "\"tools\" must be an array of tool names");
    const known = new Set([...this.deps.tools.list().map((t) => t.name), ...this.builtinTools]);
    const unknown = tools.filter((t) => !known.has(t));
    if (unknown.length) throw new AgentError("invalid", `unknown tool(s): ${unknown.join(", ")}`);
    const maxSteps = merged.maxSteps ?? DEFAULT_STEPS;
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > MAX_STEPS_CEILING)
      throw new AgentError("invalid", `"maxSteps" must be an integer between 1 and ${MAX_STEPS_CEILING}`);
    const maxTokens = merged.maxTokens ?? DEFAULT_TOKENS;
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_TOKENS_CEILING)
      throw new AgentError("invalid", `"maxTokens" must be an integer between 1 and ${MAX_TOKENS_CEILING}`);
    const parentId = merged.parentId;
    if (parentId !== undefined && typeof parentId !== "string") throw new AgentError("invalid", "\"parentId\" must be a string");
    return {
      id: existing?.id ?? "", createdAt: existing?.createdAt ?? 0,
      name: name.trim(), systemPrompt, provider, model, tools: [...tools], maxSteps, maxTokens, parentId,
    };
  }

  async createAgent(input: AgentInput): Promise<AgentDefinition> {
    const { id: _id, createdAt: _createdAt, ...record } = this.normalise(input);
    if (record.parentId && !(await this.deps.store.getAgent(record.parentId)))
      throw new AgentError("not_found", `parent agent "${record.parentId}" not found`);
    return this.deps.store.createAgent(record);
  }

  async listAgents(): Promise<AgentDefinition[]> { return this.deps.store.listAgents(); }

  async getAgent(id: string): Promise<AgentDefinition> {
    const agent = await this.deps.store.getAgent(id);
    if (!agent) throw new AgentError("not_found", `agent "${id}" not found`);
    return agent;
  }

  async updateAgent(id: string, patch: AgentPatch): Promise<AgentDefinition> {
    const existing = await this.getAgent(id);
    const next = this.normalise(patch as AgentInput, existing);
    const { id: _id, createdAt: _createdAt, ...record } = next;
    const saved = await this.deps.store.updateAgent(id, record);
    if (!saved) throw new AgentError("not_found", `agent "${id}" not found`);
    return saved;
  }

  async deleteAgent(id: string): Promise<boolean> { return this.deps.store.deleteAgent(id); }

  // ---- runs --------------------------------------------------------------

  async getRun(id: string): Promise<AgentRun> {
    const run = await this.deps.store.getRun(id);
    if (!run) throw new AgentError("not_found", `run "${id}" not found`);
    return run;
  }

  listRuns(agentId?: string): Promise<AgentRun[]> { return this.deps.store.listRuns(agentId); }

  /** Depth of a run in the spawn tree: a root run is 0. */
  async depthOf(runId: string): Promise<number> {
    let depth = 0;
    let current = await this.deps.store.getRun(runId);
    while (current?.parentRunId) {
      depth++;
      if (depth > this.maxSpawnDepth + 1) break;
      current = await this.deps.store.getRun(current.parentRunId);
    }
    return depth;
  }

  /** Creates the run record, then executes it in the background. */
  async start(agentId: string, input: string, parentRunId?: string): Promise<{ runId: string; done: Promise<AgentRun> }> {
    const agent = await this.getAgent(agentId);
    if (typeof input !== "string" || !input.trim()) throw new AgentError("invalid", "\"input\" must be a non-empty string");
    if (input.length > 20_000) throw new AgentError("invalid", "\"input\" must be 20000 characters or fewer");
    const depth = parentRunId ? (await this.depthOf(parentRunId)) + 1 : 0;
    const run = await this.deps.store.createRun({
      agentId, parentRunId, status: "running", input, output: "", steps: [], tokensUsed: 0,
    });
    const done = this.execute(run, agent, depth).finally(() => this.controllers.delete(run.id));
    return { runId: run.id, done };
  }

  /** Runs an agent to completion and returns the final record. */
  async run(agentId: string, input: string, parentRunId?: string): Promise<AgentRun> {
    const { done } = await this.start(agentId, input, parentRunId);
    return done;
  }

  async cancel(runId: string): Promise<boolean> {
    const run = await this.deps.store.getRun(runId);
    if (!run) throw new AgentError("not_found", `run "${runId}" not found`);
    if (run.status !== "running") return false;
    const controller = this.controllers.get(runId);
    if (controller) controller.abort();
    else await this.deps.store.updateRun(runId, { status: "cancelled", error: "cancelled by operator", endedAt: Date.now() });
    return true;
  }

  private specsFor(agent: AgentDefinition): ToolSpec[] {
    const specs: ToolSpec[] = this.deps.tools.list()
      .filter((t) => agent.tools.includes(t.name))
      .map((t) => ({ name: t.name, description: t.description, parameters: t.schema as unknown as Record<string, unknown> }));
    if (agent.tools.includes(SPAWN_TOOL)) specs.push(SPAWN_SPEC);
    return specs;
  }

  private async execute(run: AgentRun, agent: AgentDefinition, depth: number): Promise<AgentRun> {
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    const store = this.deps.store;
    const steps: RunStep[] = [...run.steps];
    const messages: ChatMessage[] = [
      ...(agent.systemPrompt ? [{ role: "system" as const, content: agent.systemPrompt }] : []),
      { role: "user", content: run.input },
    ];
    const specs = this.specsFor(agent);
    let tokens = 0;
    let output = "";
    let status: RunStatus = "succeeded";
    let error: string | undefined;
    let finished = false;

    const persist = async (patch: Parameters<Store["updateRun"]>[1]) => {
      await store.updateRun(run.id, { ...patch, steps });
    };

    try {
      const provider = this.deps.providers.get(agent.provider);
      if (!provider) throw new AgentError("invalid", `unknown provider "${agent.provider}"`);
      for (let step = 0; step < agent.maxSteps; step++) {
        if (controller.signal.aborted) { status = "cancelled"; error = "cancelled by operator"; break; }
        if (tokens > agent.maxTokens) { status = "budget_exceeded"; error = `token budget exhausted (${tokens}/${agent.maxTokens})`; break; }

        let chunkText = "";
        const calls: ToolCall[] = [];
        for await (const chunk of provider.stream(messages, specs, { model: agent.model, signal: controller.signal })) {
          if (chunk.type === "token") chunkText += chunk.text;
          else if (chunk.type === "tool_call") calls.push(chunk.call);
          else tokens += chunk.usage?.completionTokens ?? 0;
          if (controller.signal.aborted) break;
        }
        steps.push({ index: steps.length, kind: "assistant", text: chunkText, tokens });
        messages.push({ role: "assistant", content: chunkText, toolCalls: calls.length ? calls : undefined });
        if (chunkText) output = chunkText;
        await persist({ tokensUsed: tokens });

        if (controller.signal.aborted) { status = "cancelled"; error = "cancelled by operator"; break; }
        if (tokens > agent.maxTokens) { status = "budget_exceeded"; error = `token budget exhausted (${tokens}/${agent.maxTokens})`; break; }
        if (!calls.length) { finished = true; break; }

        for (const call of calls) {
          const outcome = await this.callTool(call, agent, run, depth, controller);
          steps.push({ ...outcome.step, index: steps.length } as RunStep);
          messages.push({ role: "tool", content: outcome.content });
          output = outcome.content || output;
          await persist({ tokensUsed: tokens, output });
          if (controller.signal.aborted) break;
        }
        if (controller.signal.aborted) { status = "cancelled"; error = "cancelled by operator"; break; }
        if (tokens > agent.maxTokens) { status = "budget_exceeded"; error = `token budget exhausted (${tokens}/${agent.maxTokens})`; break; }
      }
      if (status === "succeeded" && !finished) {
        status = "budget_exceeded";
        error = `step budget exhausted (${agent.maxSteps})`;
      }
    } catch (e) {
      status = "failed";
      error = e instanceof Error ? e.message : String(e);
    }

    const endedAt = Date.now();
    await store.updateRun(run.id, { status, output, tokensUsed: tokens, error, endedAt, steps });
    return { ...run, status, output, tokensUsed: tokens, steps, error, endedAt };
  }

  private async callTool(
    call: ToolCall, agent: AgentDefinition, parentRun: AgentRun, depth: number, controller: AbortController,
  ): Promise<{ step: RunStep; content: string }> {
    const fail = (message: string): { step: RunStep; content: string } => ({
      step: { index: -1, kind: "tool", tool: call.name, args: call.args, error: message },
      content: `error: ${message}`,
    });
    if (!agent.tools.includes(call.name))
      return fail(`tool_not_allowed: "${call.name}" is not in this agent's tool list`);
    if (call.name === SPAWN_TOOL) return this.spawn(call, parentRun, depth);
    try {
      const result = await this.deps.tools.call(call.name, call.args);
      return {
        step: { index: -1, kind: "tool", tool: call.name, args: call.args, result },
        content: typeof result === "string" ? result : JSON.stringify(result),
      };
    } catch (e) {
      const message = e instanceof ToolError ? `${e.code}: ${e.message}` : (e as Error).message;
      return fail(message);
    }
  }

  private async spawn(call: ToolCall, parentRun: AgentRun, depth: number): Promise<{ step: RunStep; content: string }> {
    const args = call.args ?? {};
    const agentId = args.agentId;
    const input = args.input;
    const fail = (message: string) => ({
      step: { index: -1, kind: "tool" as const, tool: SPAWN_TOOL, args, error: message },
      content: `error: ${message}`,
    });
    if (typeof agentId !== "string" || !agentId) return fail("agent.spawn requires a non-empty \"agentId\"");
    if (typeof input !== "string" || !input.trim()) return fail("agent.spawn requires a non-empty \"input\"");
    if (depth + 1 > this.maxSpawnDepth)
      return fail(`depth_exceeded: spawn depth limit ${this.maxSpawnDepth} reached (this run is at depth ${depth})`);
    if (!(await this.deps.store.getAgent(agentId))) return fail(`not_found: agent "${agentId}" does not exist`);
    const { runId, done } = await this.start(agentId, input, parentRun.id);
    const child = await done;
    const payload = { runId, agentId, status: child.status, output: child.output, error: child.error };
    return { step: { index: -1, kind: "tool", tool: SPAWN_TOOL, args, result: payload }, content: JSON.stringify(payload) };
  }
}
