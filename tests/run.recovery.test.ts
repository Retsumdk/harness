import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, recoverInterruptedRuns } from "../src/server/main";
import { MemoryStore } from "../src/store/memory";
import { SqliteStore } from "../src/store/sqlite";

const home = () => mkdtempSync(join(tmpdir(), "run-rec-"));

test("boot closes a run a crash left at running", async () => {
  const dir = home();
  const store = new SqliteStore(join(dir, "harness.db"));
  const agent = await store.createAgent({
    name: "Slow", systemPrompt: "x", provider: "mock", tools: [], maxSteps: 4, maxTokens: 1000,
  });
  const run = await store.createRun({
    agentId: agent.id, status: "running", input: "do the thing", output: "", steps: [], tokensUsed: 0,
  });

  const harness = await createHarness({ home: dir, token: "tok", store, seed: false });
  const after = await harness.store.getRun(run.id);
  expect(after?.status).toBe("failed");
  expect(after?.error).toContain("interrupted");
  expect(typeof after?.endedAt).toBe("number");
  await harness.store.close();
});

test("finished runs are left alone", async () => {
  const dir = home();
  const store = new SqliteStore(join(dir, "harness.db"));
  const agent = await store.createAgent({
    name: "Fast", systemPrompt: "x", provider: "mock", tools: [], maxSteps: 4, maxTokens: 1000,
  });
  const done = await store.createRun({
    agentId: agent.id, status: "succeeded", input: "in", output: "out", steps: [], tokensUsed: 3, endedAt: 1234,
  });
  const cancelled = await store.createRun({
    agentId: agent.id, status: "cancelled", input: "in", output: "", steps: [], tokensUsed: 0, endedAt: 99,
  });

  expect(await recoverInterruptedRuns(store)).toBe(0);
  expect((await store.getRun(done.id))?.output).toBe("out");
  expect((await store.getRun(done.id))?.endedAt).toBe(1234);
  expect((await store.getRun(cancelled.id))?.status).toBe("cancelled");
  await store.close();
});

test("recovery reports a count over the plain store interface", async () => {
  const store = new MemoryStore();
  const agent = await store.createAgent({
    name: "Backlog", systemPrompt: "x", provider: "mock", tools: [], maxSteps: 4, maxTokens: 1000,
  });
  for (const _ of [0, 1, 2]) {
    await store.createRun({ agentId: agent.id, status: "running", input: "i", output: "", steps: [], tokensUsed: 0 });
  }
  expect(await recoverInterruptedRuns(store)).toBe(3);
  expect((await store.listRuns()).every((r) => r.status === "failed")).toBe(true);
  await store.close();
});
