import { describe, expect, test } from "bun:test";
import { MAX_SPAWN_DEPTH, SPAWN_TOOL, type AgentRun } from "../src";
import { buildAgents, toolCall } from "./agents.helpers";

const spawn = (agentId: string, input: string) => toolCall(SPAWN_TOOL, { agentId, input });
const chain = (agentId: string, n: number): string => (n === 0 ? "leaf task" : spawn(agentId, chain(agentId, n - 1)));

async function depthMap(agents: { getRun(id: string): Promise<AgentRun> }, runs: AgentRun[]) {
  const out = new Map<string, number>();
  for (const run of runs) {
    let depth = 0;
    let cursor: AgentRun | undefined = run;
    while (cursor?.parentRunId) {
      depth++;
      cursor = await agents.getRun(cursor.parentRunId);
    }
    out.set(run.id, depth);
  }
  return out;
}

describe("agents.spawn-depth", () => {
  test("a parent waits for its child and receives the child's output", async () => {
    const { agents, store } = buildAgents();
    const child = await agents.createAgent({ name: "Worker" });
    const parent = await agents.createAgent({ name: "Manager", tools: [SPAWN_TOOL] });

    const run = await agents.run(parent.id, spawn(child.id, "do the thing"));
    expect(run.status).toBe("succeeded");

    const toolStep = run.steps.find((s) => s.kind === "tool") as any;
    expect(toolStep.tool).toBe(SPAWN_TOOL);
    expect(toolStep.result.status).toBe("succeeded");
    expect(toolStep.result.output).toBe("You said: do the thing");

    const childRun = await store.getRun(toolStep.result.runId);
    expect(childRun?.agentId).toBe(child.id);
    expect(childRun?.parentRunId).toBe(run.id);
    expect(run.output).toContain("You said: do the thing");
    expect((await agents.listRuns()).length).toBe(2);
  });

  test("spawn depth stops at three: a fourth generation is refused and never created", async () => {
    const { agents } = buildAgents();
    const agent = await agents.createAgent({ name: "Chain", tools: [SPAWN_TOOL], maxSteps: 6, maxTokens: 5000 });

    const root = await agents.run(agent.id, chain(agent.id, MAX_SPAWN_DEPTH + 1));
    const runs = await agents.listRuns(agent.id);
    const depths = await depthMap(agents, runs);

    expect(MAX_SPAWN_DEPTH).toBe(3);
    expect(runs.length).toBe(4);
    expect(Math.max(...depths.values())).toBe(3);
    expect([...depths.values()].sort()).toEqual([0, 1, 2, 3]);

    const deepest = runs.find((r) => depths.get(r.id) === 3)!;
    const refusal = deepest.steps.find((s) => s.kind === "tool" && (s as any).error) as any;
    expect(refusal.tool).toBe(SPAWN_TOOL);
    expect(refusal.error).toContain("depth_exceeded");
    expect(deepest.output).toContain("depth_exceeded");
    expect(root.status).toBe("succeeded");
  });

  test("each child points at its parent run, so the tree is walkable", async () => {
    const { agents } = buildAgents();
    const agent = await agents.createAgent({ name: "Chain", tools: [SPAWN_TOOL], maxSteps: 6, maxTokens: 5000 });
    await agents.run(agent.id, chain(agent.id, 2));
    const runs = await agents.listRuns(agent.id);
    const roots = runs.filter((r) => !r.parentRunId);
    expect(roots.length).toBe(1);
    expect(runs.length).toBe(3);
    const parents = new Set(runs.map((r) => r.parentRunId).filter(Boolean) as string[]);
    expect(parents.has(roots[0].id)).toBe(true);
    for (const id of parents) expect(runs.some((r) => r.id === id)).toBe(true);
  });

  test("spawning an agent that does not exist is an error step, not a crash", async () => {
    const { agents } = buildAgents();
    const agent = await agents.createAgent({ name: "Boss", tools: [SPAWN_TOOL] });
    const run = await agents.run(agent.id, spawn("agent_ghost", "hi"));
    const toolStep = run.steps.find((s) => s.kind === "tool") as any;
    expect(toolStep.error).toContain("not_found");
    expect(run.status).toBe("succeeded");
    expect((await agents.listRuns()).length).toBe(1);
  });

  test("spawn arguments are validated before anything starts", async () => {
    const { agents } = buildAgents();
    const agent = await agents.createAgent({ name: "Boss", tools: [SPAWN_TOOL] });
    for (const args of [{}, { agentId: "" }, { agentId: "x" }, { agentId: "x", input: "  " }]) {
      const run = await agents.run(agent.id, toolCall(SPAWN_TOOL, args));
      const toolStep = run.steps.find((s) => s.kind === "tool") as any;
      expect(toolStep.error).toContain("agent.spawn requires");
    }
    expect((await agents.listRuns()).length).toBe(4);
  });

  test("depthOf counts ancestors from the stored chain", async () => {
    const { agents } = buildAgents();
    const agent = await agents.createAgent({ name: "Chain", tools: [SPAWN_TOOL], maxSteps: 6, maxTokens: 5000 });
    const root = await agents.run(agent.id, chain(agent.id, 2));
    expect(await agents.depthOf(root.id)).toBe(0);
    const childId = (root.steps.find((s) => s.kind === "tool") as any).result.runId;
    expect(await agents.depthOf(childId)).toBe(1);
    await expect(agents.depthOf("run_missing")).resolves.toBe(0);
  });
});
