export interface AgentDefinition {
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

/** Everything about an agent except the identity the store assigns. */
export type AgentRecord = Omit<AgentDefinition, "id" | "createdAt">;
export type AgentPatch = Partial<AgentRecord>;

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

export type RunRecord = Omit<AgentRun, "id" | "startedAt">;
export type RunPatch = Partial<Pick<AgentRun, "status" | "output" | "steps" | "tokensUsed" | "error" | "endedAt">>;

export class AgentError extends Error {
  constructor(public code: "invalid" | "not_found" | "depth_exceeded" | "conflict", message: string) {
    super(message);
  }
}

export const MAX_SPAWN_DEPTH = 3;
