import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentService, ChatService, MemoryStore, MockProvider, ToolRegistry, Workspace, registerBuiltins } from "../src";
import { SEED_KEY, SEED_VERSION, seedIfNeeded } from "../src/server/seed";

function build() {
  const root = mkdtempSync(join(tmpdir(), "harness-seed-"));
  const store = new MemoryStore();
  const workspace = new Workspace(join(root, "workspace"));
  const tools = new ToolRegistry();
  registerBuiltins(tools, workspace);
  const providers = new Map([["mock", new MockProvider()]]);
  const chat = new ChatService(store, providers, tools);
  const agents = new AgentService({ store, providers, tools });
  return { store, workspace, tools, chat, agents, root, done: () => rmSync(root, { recursive: true, force: true }) };
}

describe("first-run seed", () => {
  test("an empty instance is seeded with files, two agents, a conversation and a real run", async () => {
    const b = build();
    try {
      const result = await seedIfNeeded({ store: b.store, workspace: b.workspace, agents: b.agents });
      expect(result.seeded).toBe(true);
      expect(result.agents).toBe(2);
      expect(result.files).toBe(3);

      const names = b.workspace.list(".").map((e) => e.name);
      expect(names).toEqual(["data", "notes", "README.md"]);
      expect(b.workspace.read("data/releases.csv")).toContain("0.4.0");

      const agents = await b.agents.listAgents();
      expect(agents.map((a) => a.name).sort()).toEqual(["Release Note Writer", "Research Assistant"]);
      for (const agent of agents) {
        expect(agent.systemPrompt.length).toBeGreaterThan(80);
        expect(agent.tools.length).toBeGreaterThan(0);
        expect(agent.provider).toBe("mock");
      }

      const conversations = await b.store.listConversations();
      expect(conversations.length).toBe(1);
      const messages = await b.store.listMessages(conversations[0].id);
      expect(messages.length).toBeGreaterThanOrEqual(3);
      expect(messages[0].role).toBe("user");

      const runs = await b.store.listRuns();
      expect(runs.length).toBeGreaterThan(0);
      expect(runs.every((r) => r.status !== "running")).toBe(true);
      expect(await b.store.getSetting(SEED_KEY)).toBe(SEED_VERSION);
    } finally { b.done(); }
  });

  test("a second boot does not duplicate anything", async () => {
    const b = build();
    try {
      await seedIfNeeded({ store: b.store, workspace: b.workspace, agents: b.agents });
      const again = await seedIfNeeded({ store: b.store, workspace: b.workspace, agents: b.agents });
      expect(again.seeded).toBe(false);
      expect((await b.agents.listAgents()).length).toBe(2);
      expect((await b.store.listConversations()).length).toBe(1);
    } finally { b.done(); }
  });

  test("a store that already holds data is left alone, not overwritten", async () => {
    const b = build();
    try {
      await b.store.setSetting(SEED_KEY, SEED_VERSION);
      b.workspace.write("README.md", "hand written");
      const result = await seedIfNeeded({ store: b.store, workspace: b.workspace, agents: b.agents });
      expect(result.seeded).toBe(false);
      expect(b.workspace.read("README.md")).toBe("hand written");
      expect((await b.agents.listAgents()).length).toBe(0);
    } finally { b.done(); }
  });

  test("the seeded research agent can actually answer from the seeded files", async () => {
    const b = build();
    try {
      await seedIfNeeded({ store: b.store, workspace: b.workspace, agents: b.agents });
      const research = (await b.agents.listAgents()).find((a) => a.name === "Research Assistant")!;
      const run = await b.agents.run(research.id, '/tool fs.search {"q": "Plugins"}');
      expect(run.status).toBe("succeeded");
      expect(run.steps.some((s) => s.kind === "tool" && s.tool === "fs.search")).toBe(true);
      expect(JSON.stringify(run.steps)).toContain("onboarding.md");
    } finally { b.done(); }
  });
});
