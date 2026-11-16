import { describe, expect, test } from "bun:test";
import type { Provider } from "../src";
import { buildAgents, toolCall } from "./agents.helpers";

const looper: Provider = {
  id: "looper",
  async *stream() {
    yield { type: "tool_call", call: { id: "c", name: "echo", args: { x: "again" } } };
    yield { type: "done" };
  },
};

const slow: Provider = {
  id: "slow",
  async *stream(_messages, _tools, opts) {
    for (let i = 0; i < 40; i++) {
      if (opts?.signal?.aborted) return;
      await new Promise((r) => setTimeout(r, 10));
      yield { type: "token", text: `chunk${i} ` };
    }
    yield { type: "done", usage: { promptTokens: 10, completionTokens: 40 } };
  },
};

describe("agents.budget", () => {
  test("the token ceiling stops a run and says so", async () => {
    const { agents, store } = buildAgents();
    const agent = await agents.createAgent({ name: "Tight", maxTokens: 2 });
    const run = await agents.run(agent.id, "hello there");

    expect(run.status).toBe("budget_exceeded");
    expect(run.error).toBe("token budget exhausted (7/2)");
    expect(run.tokensUsed).toBe(7);
    expect(run.endedAt).toBeDefined();
    expect((await store.getRun(run.id))?.status).toBe("budget_exceeded");
  });

  test("the step ceiling stops a tool loop instead of spinning forever", async () => {
    const { agents } = buildAgents({ provider: looper });
    const agent = await agents.createAgent({ name: "Looper", tools: ["echo"], maxSteps: 2 });
    const run = await agents.run(agent.id, "go");

    expect(run.status).toBe("budget_exceeded");
    expect(run.error).toBe("step budget exhausted (2)");
    expect(run.steps.filter((s) => s.kind === "assistant").length).toBe(2);
    expect(run.steps.filter((s) => s.kind === "tool").length).toBe(2);
  });

  test("cancel aborts a running agent and is idempotent about finished runs", async () => {
    const { agents, store } = buildAgents({ provider: slow });
    const agent = await agents.createAgent({ name: "Slow", maxTokens: 100_000 });
    const { runId, done } = await agents.start(agent.id, "keep going");

    expect(await agents.cancel(runId)).toBe(true);
    const run = await done;
    expect(run.status).toBe("cancelled");
    expect(run.error).toBe("cancelled by operator");
    expect(run.endedAt).toBeDefined();
    expect((await store.getRun(runId))?.status).toBe("cancelled");

    expect(await agents.cancel(runId)).toBe(false);
    await expect(agents.cancel("run_missing")).rejects.toMatchObject({ code: "not_found" });
  });

  test("a cancelled parent marks its own run cancelled, not succeeded", async () => {
    const { agents } = buildAgents({ provider: slow });
    const agent = await agents.createAgent({ name: "Parent", maxTokens: 100_000 });
    const { runId, done } = await agents.start(agent.id, "wait");
    await agents.cancel(runId);
    const run = await done;
    expect(run.status).toBe("cancelled");
    expect(run.output).not.toContain("chunk39");
  });

  test("token usage is persisted incrementally, so a finished run keeps its count", async () => {
    const { agents } = buildAgents();
    const agent = await agents.createAgent({ name: "Counter" });
    const run = await agents.run(agent.id, "one two three");
    const stored = await agents.getRun(run.id);
    expect(stored.tokensUsed).toBe(run.tokensUsed);
    expect(stored.steps.at(-1)).toMatchObject({ kind: "assistant", tokens: run.tokensUsed });
  });

  test("a long answer that fits the budget still succeeds", async () => {
    const { agents } = buildAgents();
    const agent = await agents.createAgent({ name: "Roomy", maxTokens: 500, maxSteps: 4 });
    const run = await agents.run(agent.id, "hello there");
    expect(run.status).toBe("succeeded");
    expect(run.error).toBeUndefined();
  });

  test("a tool result counts toward the parent budget only through the provider", async () => {
    const { agents } = buildAgents();
    const agent = await agents.createAgent({ name: "Tooler", tools: ["echo"], maxTokens: 50 });
    const run = await agents.run(agent.id, toolCall("echo", { x: "small" }));
    expect(run.status).toBe("succeeded");
    expect(run.tokensUsed).toBeGreaterThan(0);
  });
});
