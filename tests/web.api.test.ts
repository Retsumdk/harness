import { describe, expect, test } from "bun:test";
import { ApiError, HarnessApi, NetworkError, UnauthorizedError, describeError, readSse } from "../src/web/api";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const sse = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });

describe("SSE reader", () => {
  test("named events are split on blank lines and parsed as JSON", async () => {
    const seen: [string, unknown][] = [];
    await readSse(
      sse(['event: token\ndata: {"type":"token","text":"hi"}\n\n', 'event: done\ndata: {"type":"done"}\n\n']),
      (event, data) => seen.push([event, data]),
    );
    expect(seen).toEqual([
      ["token", { type: "token", text: "hi" }],
      ["done", { type: "done" }],
    ]);
  });

  test("an event split across two network reads is reassembled", async () => {
    const seen: unknown[] = [];
    await readSse(sse(['event: token\ndata: {"te', 'xt":"split"}\n\n']), (_e, d) => seen.push(d));
    expect(seen).toEqual([{ text: "split" }]);
  });

  test("non-JSON data is passed through as a string instead of throwing", async () => {
    const seen: unknown[] = [];
    await readSse(sse(["event: note\ndata: plain words\n\n"]), (_e, d) => seen.push(d));
    expect(seen).toEqual(["plain words"]);
  });

  test("a trailing partial block without a blank line is not emitted", async () => {
    const seen: unknown[] = [];
    await readSse(sse(['event: token\ndata: {"a":1}\n\n', 'event: token\ndata: {"b":2}']), (_e, d) => seen.push(d));
    expect(seen).toEqual([{ a: 1 }]);
  });
});

describe("api client", () => {
  test("the bearer token is attached to every request", async () => {
    let header: string | undefined;
    const api = new HarnessApi({
      token: "abc123",
      fetchImpl: async (_url, init) => {
        header = (init?.headers as Record<string, string>)?.authorization;
        return json({ agents: [] });
      },
    });
    await api.listAgents();
    expect(header).toBe("Bearer abc123");
  });

  test("a 401 becomes UnauthorizedError, not a generic failure", async () => {
    const api = new HarnessApi({ fetchImpl: async () => json({ error: { code: "unauthorized", message: "no" } }, 401) });
    await expect(api.listAgents()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  test("the server's error envelope message reaches the caller", async () => {
    const api = new HarnessApi({
      fetchImpl: async () => json({ error: { code: "bad_request", message: '"maxSteps" must be an integer' } }, 400),
    });
    const err = await api.createAgent({ name: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.code).toBe("bad_request");
    expect(err.message).toContain("maxSteps");
  });

  test("a transport failure is a NetworkError a person can read", async () => {
    const api = new HarnessApi({ fetchImpl: async () => { throw new TypeError("connect ECONNREFUSED"); } });
    const err = await api.listConversations().catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(describeError(err)).toContain("cannot reach");
  });

  test("paths are url-encoded so a slash in a file name cannot climb the tree", async () => {
    let url = "";
    const api = new HarnessApi({
      token: "t",
      fetchImpl: async (u) => { url = u; return json({ type: "dir", path: ".", entries: [] }); },
    });
    await api.files("../secret dir");
    expect(url).toBe("/api/files?path=..%2Fsecret%20dir");
  });

  test("chat resolves the conversation id from the done event and forwards every event", async () => {
    const events: string[] = [];
    const api = new HarnessApi({
      token: "t",
      fetchImpl: async () =>
        new Response(
          sse(['event: token\ndata: {"type":"token","text":"Hey"}\n\n', 'event: done\ndata: {"type":"done","conversationId":"conv_1"}\n\n']),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });
    const id = await api.chat({ message: "hi" }, { onEvent: (e) => events.push(e.type) });
    expect(id).toBe("conv_1");
    expect(events).toEqual(["token", "done"]);
  });

  test("a failed chat start surfaces the JSON error instead of an empty stream", async () => {
    const api = new HarnessApi({
      fetchImpl: async () => json({ error: { code: "bad_request", message: "message too long" } }, 400),
    });
    await expect(api.chat({ message: "x" }, { onEvent: () => undefined })).rejects.toThrow("message too long");
  });

  test("the run stream opens, forwards events and closes", async () => {
    const events: string[] = [];
    const api = new HarnessApi({
      token: "t",
      fetchImpl: async () =>
        new Response(sse(['event: step\ndata: {"index":0}\n\n', 'event: done\ndata: {"status":"succeeded"}\n\n']), { status: 200 }),
    });
    const opened = await new Promise<boolean>((resolve) => {
      api.streamRun("run_1", {
        onOpen: () => resolve(true),
        onEvent: (event) => events.push(event),
        onClose: () => undefined,
      });
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(opened).toBe(true);
    expect(events).toEqual(["step", "done"]);
  });

  test("setToken swaps the credential without rebuilding the client", async () => {
    let header: string | undefined;
    const api = new HarnessApi({
      fetchImpl: async (_u, init) => { header = (init?.headers as Record<string, string>)?.authorization; return json({ conversations: [] }); },
    });
    await api.listConversations();
    expect(header).toBeUndefined();
    api.setToken("later");
    await api.listConversations();
    expect(header).toBe("Bearer later");
  });
});

describe("api client — every documented call", () => {
  type Call = { method: string; path: string; body: unknown };
  const recorder = (respond: (call: Call) => unknown) => {
    const calls: Call[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const call = { method: init?.method ?? "GET", path: url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      return json(respond(call));
    };
    return { calls, api: new HarnessApi({ token: "t", fetchImpl }) };
  };

  test("conversation reads and deletes hit the right routes", async () => {
    const { api, calls } = recorder(() => ({ conversation: { id: "conv_1" }, messages: [] }));
    await api.getConversation("conv_1");
    await api.deleteConversation("conv_1");
    await api.health();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/conversations/conv_1",
      "DELETE /api/conversations/conv_1",
      "GET /health",
    ]);
  });

  test("file writes and deletes carry the path in the query string and content in the body", async () => {
    const { api, calls } = recorder(() => ({ ok: true, path: "notes/a.md", size: 3, results: [], type: "file", content: "hi", entries: [] }));
    await api.writeFile("notes/a.md", "hi");
    await api.deleteFile("notes/a.md");
    await api.searchFiles("release");
    expect(calls[0]).toEqual({ method: "PUT", path: "/api/files?path=notes%2Fa.md", body: { content: "hi" } });
    expect(calls[1].method).toBe("DELETE");
    expect(calls[2].path).toBe("/api/files/search?q=release");
  });

  test("agent CRUD and runs use PATCH for updates and the run routes for execution", async () => {
    const { api, calls } = recorder((call) => {
      if (call.path.endsWith("/runs")) return { runId: "run_9" };
      if (call.path.startsWith("/api/runs/") && call.path.endsWith("/cancel")) return { cancelled: true };
      if (call.path.startsWith("/api/runs/")) return { run: { id: "run_9", steps: [] } };
      if (call.path.includes("?agentId=")) return { runs: [{ id: "run_9" }] };
      if (call.method === "DELETE") return { ok: true };
      return { agent: { id: "agent_1" }, agents: [] };
    });
    await api.listAgents();
    await api.getAgent("agent_1");
    await api.createAgent({ name: "Reader" });
    await api.updateAgent("agent_1", { name: "Reader 2" });
    await api.deleteAgent("agent_1");
    await api.listRuns("agent_1");
    expect(await api.startRun("agent_1", "go")).toBe("run_9");
    expect((await api.getRun("run_9")).id).toBe("run_9");
    expect(await api.cancelRun("run_9")).toBe(true);
    expect(api.streamRunUrl("run_9")).toBe("/api/runs/run_9/stream");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/agents",
      "GET /api/agents/agent_1",
      "POST /api/agents",
      "PATCH /api/agents/agent_1",
      "DELETE /api/agents/agent_1",
      "GET /api/runs?agentId=agent_1",
      "POST /api/agents/agent_1/runs",
      "GET /api/runs/run_9",
      "POST /api/runs/run_9/cancel",
    ]);
    expect(calls[6].body).toEqual({ input: "go" });
  });

  test("plugin lifecycle and module toggles are all wired", async () => {
    const { api, calls } = recorder((call) =>
      call.path.includes("/modules") ? { module: { id: "tools", state: "running" }, modules: [] } : { plugin: { id: "github" }, plugins: [], ok: true },
    );
    await api.listPlugins();
    await api.enablePlugin("github");
    await api.disablePlugin("github");
    await api.configurePlugin("github", { token: "x" });
    await api.uninstallPlugin("github");
    await api.listModules();
    await api.enableModule("tools");
    await api.disableModule("tools");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/plugins",
      "POST /api/plugins/github/enable",
      "POST /api/plugins/github/disable",
      "PUT /api/plugins/github/config",
      "DELETE /api/plugins/github",
      "GET /api/modules",
      "POST /api/modules/tools/enable",
      "POST /api/modules/tools/disable",
    ]);
    expect(calls[3].body).toEqual({ token: "x" });
  });

  test("settings round-trip keeps the server's answer rather than the local guess", async () => {
    const { api, calls } = recorder(() => ({ settings: { provider: "mock", model: "" } }));
    expect(await api.saveSettings({ provider: "mock" })).toEqual({ settings: { provider: "mock", model: "" } });
    expect(calls[0]).toEqual({ method: "PUT", path: "/api/settings", body: { provider: "mock" } });
  });
});
