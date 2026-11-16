import { describe, expect, test } from "bun:test";
import { AgentError, SPAWN_TOOL, type Chunk, type Provider } from "../src";
import { buildAgents, buildApp, toolCall } from "./agents.helpers";

describe("agents.runner", () => {
  test("definitions: create applies defaults, lists, updates and deletes", async () => {
    const { agents } = buildAgents();
    const created = await agents.createAgent({ name: "  Analyst  ", systemPrompt: "You analyse." });
    expect(created.name).toBe("Analyst");
    expect(created.provider).toBe("mock");
    expect(created.tools).toEqual([]);
    expect(created.maxSteps).toBe(8);
    expect(created.maxTokens).toBe(2000);
    expect(created.id).toStartWith("agent_");

    const second = await agents.createAgent({ name: "Writer", maxSteps: 3, maxTokens: 50, tools: ["echo"] });
    expect((await agents.listAgents()).map((a) => a.name)).toEqual(["Analyst", "Writer"]);

    const updated = await agents.updateAgent(second.id, { maxSteps: 5, systemPrompt: "Write tersely." });
    expect(updated.maxSteps).toBe(5);
    expect(updated.systemPrompt).toBe("Write tersely.");
    expect(updated.name).toBe("Writer");

    expect(await agents.deleteAgent(second.id)).toBe(true);
    expect(await agents.deleteAgent(second.id)).toBe(false);
    await expect(agents.getAgent(second.id)).rejects.toBeInstanceOf(AgentError);
  });

  test("definitions are validated: names, providers, tools, budgets", async () => {
    const { agents } = buildAgents();
    const bad: Record<string, unknown>[] = [
      {}, { name: "" }, { name: "x".repeat(65) },
      { name: "ok", provider: "nope" },
      { name: "ok", tools: ["not_a_tool"] },
      { name: "ok", tools: "echo" },
      { name: "ok", maxSteps: 0 }, { name: "ok", maxSteps: 1.5 }, { name: "ok", maxSteps: 51 },
      { name: "ok", maxTokens: 0 }, { name: "ok", maxTokens: 200_001 },
      { name: "ok", systemPrompt: 5 }, { name: "ok", systemPrompt: "x".repeat(20001) },
    ];
    for (const input of bad) {
      await expect(agents.createAgent(input as any)).rejects.toMatchObject({ code: "invalid" });
    }
    await expect(agents.createAgent({ name: "ok", parentId: "agent_missing" })).rejects.toMatchObject({ code: "not_found" });
    const builtin = await agents.createAgent({ name: "WithSpawn", tools: [SPAWN_TOOL, "echo"] });
    expect(builtin.tools).toEqual([SPAWN_TOOL, "echo"]);
  });

  test("a run completes: assistant step persisted, tokens counted, endedAt set", async () => {
    const { agents, store } = buildAgents();
    const agent = await agents.createAgent({ name: "Echo", systemPrompt: "Be brief." });
    const run = await agents.run(agent.id, "hello world");

    expect(run.status).toBe("succeeded");
    expect(run.output).toBe("You said: hello world");
    expect(run.tokensUsed).toBeGreaterThan(0);
    expect(run.endedAt).toBeGreaterThan(0);
    expect(run.error).toBeUndefined();
    expect(run.steps).toEqual([{ index: 0, kind: "assistant", text: "You said: hello world", tokens: run.tokensUsed }]);

    const stored = await store.getRun(run.id);
    expect(stored?.status).toBe("succeeded");
    expect(stored?.output).toBe("You said: hello world");
    expect((await agents.listRuns(agent.id)).map((r) => r.id)).toEqual([run.id]);
  });

  test("the system prompt is sent to the provider on the first turn", async () => {
    const seen: { roles: string[]; system?: string } = { roles: [] };
    const spy: Provider = {
      id: "mock",
      async *stream(messages): AsyncIterable<Chunk> {
        seen.roles = messages.map((m) => m.role);
        seen.system = messages[0]?.content;
        yield { type: "token", text: "ok" };
        yield { type: "done", usage: { promptTokens: 1, completionTokens: 1 } };
      },
    };
    const { agents } = buildAgents({ provider: spy });
    const agent = await agents.createAgent({ name: "Sys", systemPrompt: "You are terse." });
    await agents.run(agent.id, "hi");
    expect(seen.roles).toEqual(["system", "user"]);
    expect(seen.system).toBe("You are terse.");
  });

  test("a tool call runs, its result is fed back, and the loop finishes", async () => {
    const { agents } = buildAgents();
    const agent = await agents.createAgent({ name: "Tooled", tools: ["echo"] });
    const run = await agents.run(agent.id, toolCall("echo", { x: "hi" }));

    expect(run.status).toBe("succeeded");
    expect(run.steps.map((s) => s.kind)).toEqual(["assistant", "tool", "assistant"]);
    expect((run.steps[1] as any).result).toBe("got hi");
    expect(run.output).toBe("Tool result: got hi");
  });

  test("only tools on the agent's allowlist are callable at run time", async () => {
    let turn = 0;
    const sneaky: Provider = {
      id: "mock",
      async *stream(): AsyncIterable<Chunk> {
        if (turn++ === 0) {
          yield { type: "tool_call", call: { id: "c1", name: "fs.read", args: { path: "/etc/passwd" } } };
        } else {
          yield { type: "token", text: "blocked" };
        }
        yield { type: "done", usage: { promptTokens: 1, completionTokens: 1 } };
      },
    };
    const { agents } = buildAgents({ provider: sneaky });
    const agent = await agents.createAgent({ name: "Locked", tools: ["echo"] });
    const run = await agents.run(agent.id, "read a file");
    const toolStep = run.steps.find((s) => s.kind === "tool") as any;
    expect(toolStep.error).toContain("tool_not_allowed");
    expect(run.status).toBe("succeeded");
  });

  test("a failing tool is reported in the step and the run continues", async () => {
    const { agents } = buildAgents();
    const agent = await agents.createAgent({ name: "BadArgs", tools: ["echo"] });
    const run = await agents.run(agent.id, toolCall("echo", {}));
    const toolStep = run.steps.find((s) => s.kind === "tool") as any;
    expect(toolStep.error).toContain("invalid_args");
    expect(run.status).toBe("succeeded");
    expect(run.output).toContain("Tool result: error:");
  });

  test("a provider that blows up ends the run as failed with the message", async () => {
    const { agents, providers } = buildAgents();
    const agent = await agents.createAgent({ name: "Orphan" });
    providers.delete(agent.provider);
    const run = await agents.run(agent.id, "hello");
    expect(run.status).toBe("failed");
    expect(run.error).toContain("unknown provider");
    expect(run.endedAt).toBeGreaterThan(0);
  });

  test("run inputs are validated and unknown ids are not_found", async () => {
    const { agents } = buildAgents();
    const agent = await agents.createAgent({ name: "Strict" });
    for (const input of ["", "   "]) await expect(agents.start(agent.id, input)).rejects.toMatchObject({ code: "invalid" });
    await expect(agents.start(agent.id, "x".repeat(20_001))).rejects.toMatchObject({ code: "invalid" });
    await expect(agents.start("agent_missing", "hi")).rejects.toMatchObject({ code: "not_found" });
    await expect(agents.getRun("run_missing")).rejects.toMatchObject({ code: "not_found" });
    await expect(agents.cancel("run_missing")).rejects.toMatchObject({ code: "not_found" });
  });

  test("HTTP API: create, list, update, run, poll and delete an agent", async () => {
    const { app, auth } = buildApp();
    const created = await app.request("/api/agents", {
      method: "POST", headers: auth,
      body: JSON.stringify({ name: "Api Agent", systemPrompt: "Be useful.", tools: ["echo"] }),
    });
    expect(created.status).toBe(201);
    const agent = (await created.json()).agent;
    expect(agent.name).toBe("Api Agent");

    expect((await (await app.request("/api/agents", { headers: auth })).json()).agents.length).toBe(1);
    expect((await (await app.request(`/api/agents/${agent.id}`, { headers: auth })).json()).agent.id).toBe(agent.id);

    const patched = await app.request(`/api/agents/${agent.id}`, {
      method: "PATCH", headers: auth, body: JSON.stringify({ maxSteps: 2 }),
    });
    expect((await patched.json()).agent.maxSteps).toBe(2);

    const started = await app.request(`/api/agents/${agent.id}/runs`, {
      method: "POST", headers: auth, body: JSON.stringify({ input: "hello api" }),
    });
    expect(started.status).toBe(202);
    const { runId } = await started.json();

    let run: any;
    for (let i = 0; i < 100; i++) {
      run = (await (await app.request(`/api/runs/${runId}`, { headers: auth })).json()).run;
      if (run.status !== "running") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(run.status).toBe("succeeded");
    expect(run.output).toBe("You said: hello api");

    const stream = await app.request(`/api/runs/${runId}/stream`, { headers: auth });
    const sse = await stream.text();
    expect(sse).toContain("event: step");
    expect(sse).toContain("event: done");

    expect((await app.request(`/api/agents/${agent.id}`, { method: "DELETE", headers: auth })).status).toBe(200);
    expect((await app.request(`/api/agents/${agent.id}`, { headers: auth })).status).toBe(404);
    expect((await app.request("/api/runs/run_missing", { headers: auth })).status).toBe(404);
    expect((await app.request(`/api/agents/${agent.id}/runs`, {
      method: "POST", headers: auth, body: JSON.stringify({ input: "x" }),
    })).status).toBe(404);
  });

  test("HTTP API rejects bad agent bodies and requires auth", async () => {
    const { app, auth } = buildApp();
    expect((await app.request("/api/agents")).status).toBe(401);
    for (const body of ["{nope", "[]", '{"name":""}', '{"name":"ok","maxSteps":0}']) {
      const r = await app.request("/api/agents", { method: "POST", headers: auth, body });
      expect(r.status).toBe(400);
      expect((await r.json()).error.code).toBe("bad_request");
    }
    const agent = (await (await app.request("/api/agents", { method: "POST", headers: auth, body: '{"name":"Runs"}' })).json()).agent;
    const noInput = await app.request(`/api/agents/${agent.id}/runs`, { method: "POST", headers: auth, body: "{}" });
    expect(noInput.status).toBe(400);
    expect((await app.request("/api/agents/agent_missing", { headers: auth })).status).toBe(404);
    expect((await app.request("/api/agents/agent_missing", { method: "PATCH", headers: auth, body: "{}" })).status).toBe(404);
    expect((await app.request("/api/agents/agent_missing", { method: "DELETE", headers: auth })).status).toBe(404);
  });

  test("HTTP API reports a cancel of an unknown run as 404", async () => {
    const { app, auth } = buildApp();
    expect((await app.request("/api/runs/run_missing/cancel", { method: "POST", headers: auth })).status).toBe(404);
  });
});

test("run SSE stream replays steps and closes with the terminal status", async () => {
  const { app, agents, auth } = buildApp();
  const created = await (await app.request("/api/agents", {
    method: "POST", headers: auth, body: JSON.stringify({ name: "Streamer", tools: ["echo"] }),
  })).json();
  const started = await app.request(`/api/agents/${created.agent.id}/runs`, {
    method: "POST", headers: auth, body: JSON.stringify({ input: toolCall("echo", { x: "sse" }) }),
  });
  expect(started.status).toBe(202);
  const { runId } = await started.json();
  await agents.getRun(runId);
  await new Promise((r) => setTimeout(r, 50));

  const stream = await app.request(`/api/runs/${runId}/stream`, { headers: auth });
  expect(stream.headers.get("content-type")).toContain("text/event-stream");
  const body = await stream.text();
  expect(body).toContain("event: step");
  expect(body).toContain('"tool":"echo"');
  expect(body).toContain("event: done");
  expect(body).toContain('"status":"succeeded"');
});
