import { describe, expect, test } from "bun:test";
import { MemoryStore, SqliteStore, NotFoundError, type Store } from "../src";

const impls: [string, () => Store][] = [["memory", () => new MemoryStore()], ["sqlite", () => new SqliteStore()]];

for (const [name, make] of impls) {
  describe(`store.contract (${name})`, () => {
    test("conversations and ordered messages round-trip", async () => {
      const s = make();
      const c = await s.createConversation("Hello", "agent_1");
      const c2 = await s.createConversation("Second");
      expect((await s.listConversations()).map((x) => x.id)).toEqual([c2.id, c.id]);
      expect((await s.getConversation(c.id))?.agentId).toBe("agent_1");
      await s.addMessage({ conversationId: c.id, role: "user", content: "hi" });
      await s.addMessage({ conversationId: c.id, role: "assistant", content: "", toolCalls: [{ id: "t1", name: "fs.read", args: { path: "a" } }] });
      const msgs = await s.listMessages(c.id);
      expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(msgs[1].toolCalls?.[0].name).toBe("fs.read");
      await s.close();
    });
    test("adding to a missing conversation throws NotFoundError; delete cascades", async () => {
      const s = make();
      await expect(s.addMessage({ conversationId: "nope", role: "user", content: "x" })).rejects.toBeInstanceOf(NotFoundError);
      const c = await s.createConversation("t");
      await s.addMessage({ conversationId: c.id, role: "user", content: "x" });
      expect(await s.deleteConversation(c.id)).toBe(true);
      expect(await s.deleteConversation(c.id)).toBe(false);
      expect(await s.listMessages(c.id)).toEqual([]);
      expect(await s.getConversation(c.id)).toBeUndefined();
      await s.close();
    });
    test("settings upsert", async () => {
      const s = make();
      expect(await s.getSetting("k")).toBeUndefined();
      await s.setSetting("k", "1"); await s.setSetting("k", "2");
      expect(await s.getSetting("k")).toBe("2");
      await s.close();
    });
  });
}

test("store.contract (sqlite) persists across reopen", async () => {
  const path = `/tmp/harness-${crypto.randomUUID()}.db`;
  const a = new SqliteStore(path);
  const c = await a.createConversation("persist");
  await a.addMessage({ conversationId: c.id, role: "user", content: "keep me" });
  await a.close();
  const b = new SqliteStore(path);
  expect((await b.listMessages(c.id))[0].content).toBe("keep me");
  await b.addMessage({ conversationId: c.id, role: "assistant", content: "next" });
  expect((await b.listMessages(c.id)).map((m) => m.content)).toEqual(["keep me", "next"]);
  await b.close();
});

for (const [name, make] of impls) {
  describe(`store.contract agents+runs (${name})`, () => {
    const def = { name: "Analyst", systemPrompt: "why", provider: "mock", tools: ["fs.read"], maxSteps: 4, maxTokens: 100 };

    test("agents round-trip: create, list, partial update, delete", async () => {
      const s = make();
      const a = await s.createAgent(def);
      expect(a.id).toStartWith("agent_");
      expect(a.model).toBeUndefined();
      expect(a.parentId).toBeUndefined();

      const b = await s.createAgent({ ...def, name: "Writer", tools: [], parentId: a.id });
      expect((await s.listAgents()).map((x) => x.name)).toEqual(["Analyst", "Writer"]);

      const updated = await s.updateAgent(b.id, { maxSteps: 9, tools: ["echo", "fs.write"] });
      expect(updated).toMatchObject({ name: "Writer", maxSteps: 9, tools: ["echo", "fs.write"], parentId: a.id });
      expect((await s.getAgent(b.id))?.maxSteps).toBe(9);

      expect(await s.getAgent("agent_missing")).toBeUndefined();
      expect(await s.updateAgent("agent_missing", { maxSteps: 1 })).toBeUndefined();
      expect(await s.deleteAgent(b.id)).toBe(true);
      expect(await s.deleteAgent(b.id)).toBe(false);
      await s.close();
    });

    test("runs round-trip: steps, tokens, terminal update, filter by agent", async () => {
      const s = make();
      const a = await s.createAgent(def);
      const run = await s.createRun({ agentId: a.id, status: "running", input: "go", output: "", steps: [], tokensUsed: 0 });
      expect(run.id).toStartWith("run_");
      expect(run.parentRunId).toBeUndefined();

      const steps = [{ index: 0, kind: "assistant" as const, text: "hi", tokens: 2 }];
      const done = await s.updateRun(run.id, { status: "succeeded", output: "hi", steps, tokensUsed: 2, endedAt: 1234 });
      expect(done).toMatchObject({ status: "succeeded", tokensUsed: 2, endedAt: 1234 });
      expect((await s.getRun(run.id))?.steps).toEqual(steps);

      const child = await s.createRun({ agentId: a.id, parentRunId: run.id, status: "succeeded", input: "x", output: "y", steps: [], tokensUsed: 0 });
      expect(child.parentRunId).toBe(run.id);
      expect((await s.listRuns(a.id)).map((r) => r.id)).toEqual([run.id, child.id]);
      expect((await s.listRuns()).length).toBe(2);
      expect(await s.getRun("run_missing")).toBeUndefined();
      expect(await s.updateRun("run_missing", { status: "failed" })).toBeUndefined();
      await s.close();
    });
  });
}

test("store.contract (sqlite) persists agents and runs across reopen", async () => {
  const path = `/tmp/harness-agents-${crypto.randomUUID()}.db`;
  const a = new SqliteStore(path);
  const agent = await a.createAgent({ name: "Persisted", systemPrompt: "s", provider: "mock", tools: ["echo"], maxSteps: 3, maxTokens: 40 });
  const run = await a.createRun({ agentId: agent.id, status: "succeeded", input: "keep", output: "kept", steps: [], tokensUsed: 3, endedAt: 99 });
  await a.close();

  const b = new SqliteStore(path);
  expect((await b.getAgent(agent.id))?.name).toBe("Persisted");
  const back = await b.getRun(run.id);
  expect(back).toMatchObject({ agentId: agent.id, status: "succeeded", output: "kept", tokensUsed: 3, endedAt: 99 });
  expect((await b.listRuns(agent.id)).length).toBe(1);
  await b.close();
});
