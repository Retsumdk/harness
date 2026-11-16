import { describe, expect, test } from "bun:test";
import {
  PluginError, PluginService, MemoryStore, ToolRegistry, ToolError,
  validateManifest, maskConfig, missingRequired, githubPlugin, webhookPlugin,
  createApp, ChatService, MockProvider,
} from "../src";
import type { PluginImplementation } from "../src";

const goodManifest = (over: Record<string, unknown> = {}) => ({
  id: "notes",
  name: "Notes",
  version: "1.2.0",
  description: "Note taking tools",
  permissions: ["filesystem"],
  config: [
    { name: "folder", type: "string", required: true, description: "Where notes are stored" },
    { name: "apiKey", type: "string", secret: true },
  ],
  tools: [
    {
      name: "notes.add",
      description: "Add a note",
      schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  ],
  ...over,
});

const notesPlugin = (): PluginImplementation => ({
  manifest: validateManifest(goodManifest()),
  handlers: { "notes.add": (args) => ({ saved: String(args.text) }) },
});

const fakeFetch = (calls: { url: string; init?: RequestInit }[], respond: () => Response) =>
  (async (input: any, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond();
  }) as any;

describe("plugins.manifest — manifest validation", () => {
  test("a well-formed manifest is accepted and defaults are filled in", () => {
    const m = validateManifest(goodManifest({ description: undefined, permissions: undefined }));
    expect(m.id).toBe("notes");
    expect(m.description).toBe("");
    expect(m.permissions).toEqual([]);
    expect(m.config[0]).toMatchObject({ name: "folder", required: true, secret: false });
    expect(m.tools[0].name).toBe("notes.add");
  });

  test("every problem in a bad manifest is reported in one error", () => {
    try {
      validateManifest({
        id: "Bad ID",
        name: "",
        version: "1.0",
        permissions: ["root"],
        extra: true,
        config: [{ name: "9bad", type: "date" }],
        tools: [{ name: "unqualified", description: "", schema: { type: "array" } }],
      });
      throw new Error("expected a rejection");
    } catch (e) {
      expect(e).toBeInstanceOf(PluginError);
      expect((e as PluginError).code).toBe("invalid");
      const msg = (e as Error).message;
      for (const fragment of [
        "unexpected field \"extra\"",
        "\"id\" must be 2-39 chars",
        "\"name\" must be a non-empty string",
        "\"version\" must be semver",
        "unknown permission \"root\"",
        "config[0].name must be a valid identifier",
        "config[0].type must be string, number or boolean",
        "tools[0].name must look like",
        "tools[0].schema must be an object schema",
      ]) expect(msg).toContain(fragment);
    }
  });

  test("tools must be namespaced under the plugin id and unique", () => {
    const dup = goodManifest({
      tools: [
        { name: "notes.add", description: "a", schema: { type: "object", properties: {} } },
        { name: "notes.add", description: "b", schema: { type: "object", properties: {} } },
        { name: "other.add", description: "c", schema: { type: "object", properties: {} } },
      ],
    });
    expect(() => validateManifest(dup)).toThrow(/duplicate tool "notes.add"/);
    expect(() => validateManifest(dup)).toThrow(/must be namespaced under "notes\."/);
  });

  test("non-objects and missing tools are rejected, not defaulted", () => {
    expect(() => validateManifest(null)).toThrow("manifest must be an object");
    expect(() => validateManifest([])).toThrow("manifest must be an object");
    expect(() => validateManifest(goodManifest({ tools: undefined }))).toThrow("must be an array with at least one tool");
    expect(() => validateManifest(goodManifest({ tools: [] }))).toThrow("at least one tool");
  });
});

describe("plugins.manifest — runtime install, enable, configure, disable", () => {
  const build = () => {
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    const plugins = new PluginService({ store, tools });
    plugins.registerImplementation(notesPlugin());
    return { store, tools, plugins };
  };

  test("built-ins ship installed-but-disabled, and their tools are not callable yet", async () => {
    const { plugins, tools } = build();
    const list = await plugins.seedBuiltins();
    expect(list.map((p) => p.id)).toEqual(["github", "notes", "webhook"]);
    for (const p of list.filter((x) => x.id !== "notes")) {
      expect(p.enabled).toBe(false);
      expect(p.tools.length).toBeGreaterThan(0);
      for (const t of p.tools) expect(tools.has(t)).toBe(false);
      expect(p.installed).toBe(false);
    }
    expect(await tools.call("github.get_repo", { owner: "a", repo: "b" }).catch((e) => (e as ToolError).code)).toBe("unknown_tool");
  });

  test("enabling without required config is refused before any tool appears", async () => {
    const { plugins, tools } = build();
    await plugins.install(goodManifest());
    const err = await plugins.enable("notes").catch((e) => e as PluginError);
    expect(err).toBeInstanceOf(PluginError);
    expect((err as PluginError).code).toBe("config_missing");
    expect((err as Error).message).toContain("folder");
    expect(tools.has("notes.add")).toBe(false);

    const rec = await plugins.get("notes");
    expect(rec.enabled).toBe(false);
    expect(rec.missingRequired).toEqual(["folder"]);
  });

  test("configure then enable registers the tools for real; disable withdraws them", async () => {
    const { plugins, tools } = build();
    await plugins.install(goodManifest());

    const configured = await plugins.configure("notes", { folder: "inbox" });
    expect(configured.missingRequired).toEqual([]);
    expect(configured.configValues).toMatchObject({ folder: "inbox" });

    const enabled = await plugins.enable("notes");
    expect(enabled.enabled).toBe(true);
    expect(enabled.installed).toBe(true);
    expect(tools.list().map((t) => t.name)).toContain("notes.add");
    expect(await tools.call("notes.add", { text: "hello" })).toEqual({ saved: "hello" });

    const disabled = await plugins.disable("notes");
    expect(disabled.enabled).toBe(false);
    expect(disabled.installed).toBe(false);
    expect(tools.has("notes.add")).toBe(false);
    expect(await tools.call("notes.add", { text: "x" }).catch((e) => (e as ToolError).code)).toBe("unknown_tool");
  });

  test("secret config values are stored but never echoed by the API view", async () => {
    const { plugins } = build();
    await plugins.install(goodManifest());
    const v = await plugins.configure("notes", { folder: "inbox", apiKey: "sk-live-123" });
    expect(v.configValues.apiKey).toBe("••••••");
    expect(JSON.stringify(await plugins.list())).not.toContain("sk-live-123");
    expect(missingRequired(validateManifest(goodManifest()), { folder: "x", apiKey: "y" })).toEqual([]);
    expect(maskConfig(validateManifest(goodManifest()), { folder: "x" })).toEqual({ folder: "x" });
  });

  test("config writes are validated server-side: unknown keys and wrong types are rejected", async () => {
    const { plugins } = build();
    await plugins.install(goodManifest());
    expect(await plugins.configure("notes", { nope: "x" }).catch((e) => (e as PluginError).code)).toBe("invalid");
    expect(await plugins.configure("notes", { folder: 7 }).catch((e) => (e as PluginError).code)).toBe("invalid");
    expect(await plugins.configure("notes", "folder=inbox").catch((e) => (e as PluginError).code)).toBe("invalid");
    expect((await plugins.get("notes")).configValues).toEqual({});
  });

  test("an enabled plugin cannot be uninstalled; a disabled one can", async () => {
    const { plugins } = build();
    await plugins.install(goodManifest());
    await plugins.configure("notes", { folder: "inbox" });
    await plugins.enable("notes");
    expect(await plugins.uninstall("notes").catch((e) => (e as PluginError).code)).toBe("conflict");
    await plugins.disable("notes");
    expect(await plugins.uninstall("notes")).toBe(true);
    expect(await plugins.get("notes").catch((e) => (e as PluginError).code)).toBe("not_found");
  });

  test("a manifest with no registered implementation cannot be installed", async () => {
    const { plugins } = build();
    const rogue = goodManifest({ id: "rogue", tools: [{ name: "rogue.act", description: "x", schema: { type: "object", properties: {} } }] });
    expect(await plugins.install(rogue).catch((e) => (e as PluginError).code)).toBe("unsupported");
  });

  test("installing a plugin whose tool name is already taken is a conflict, not a silent overwrite", async () => {
    const { plugins, tools } = build();
    tools.register({ name: "notes.add", description: "squatter", schema: { type: "object", properties: {} }, run: () => "squatted" });
    expect(await plugins.install(goodManifest()).catch((e) => (e as PluginError).code)).toBe("conflict");
    expect(await tools.call("notes.add", {})).toBe("squatted");
  });
});

describe("plugins.manifest — built-in github and webhook", () => {
  test("github tools call the API with the configured token and return a shaped result", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = fakeFetch(calls, () => Response.json({ full_name: "acme/widgets", stargazers_count: 12, open_issues_count: 3, default_branch: "main", private: true, html_url: "https://example.test/acme/widgets" }));
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    const plugins = new PluginService({ store, tools, fetchImpl });
    await plugins.install(githubPlugin().manifest);
    await plugins.configure("github", { token: "ghp_secret" });
    await plugins.enable("github");

    const out: any = await tools.call("github.get_repo", { owner: "acme", repo: "widgets" });
    expect(out).toMatchObject({ fullName: "acme/widgets", stars: 12, openIssues: 3, defaultBranch: "main", private: true });
    expect(calls[0].url).toBe("https://api.github.com/repos/acme/widgets");
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe("Bearer ghp_secret");

    await tools.call("github.create_issue", { owner: "acme", repo: "widgets", title: "Crash on save" });
    expect(String(calls[1].url)).toBe("https://api.github.com/repos/acme/widgets/issues");
    expect(calls[1].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ title: "Crash on save", body: "" });
  });

  test("github rejects a non-github-shaped owner/repo before making a request", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = fakeFetch(calls, () => Response.json({}));
    const tools = new ToolRegistry();
    const plugins = new PluginService({ store: new MemoryStore(), tools, fetchImpl });
    await plugins.install(githubPlugin().manifest);
    await plugins.configure("github", { token: "ghp_secret" });
    await plugins.enable("github");
    expect(await tools.call("github.get_repo", { owner: "../etc", repo: "passwd" }).catch((e) => (e as ToolError).code)).toBe("invalid_args");
    expect(calls).toHaveLength(0);
  });

  test("webhook signs the payload and refuses to probe the host it runs on", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = fakeFetch(calls, () => Response.json({ ok: true }, { status: 202 }));
    const tools = new ToolRegistry();
    const plugins = new PluginService({ store: new MemoryStore(), tools, fetchImpl });
    await plugins.install(webhookPlugin().manifest);
    await plugins.configure("webhook", { url: "https://hooks.example.com/abc", secret: "s3cr3t" });
    await plugins.enable("webhook");

    const out: any = await tools.call("webhook.send", { event: "run.finished", payload: { runId: "r1" } });
    expect(out).toEqual({ status: 202, event: "run.finished", delivered: true });
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["x-harness-event"]).toBe("run.finished");
    expect(headers["x-harness-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ event: "run.finished", payload: { runId: "r1" } });

    await plugins.configure("webhook", { url: "http://127.0.0.1:8080/admin" });
    expect(await tools.call("webhook.send", { event: "x" }).catch((e) => (e as ToolError).message)).toContain("public");
    await plugins.configure("webhook", { url: "http://localhost/hook" });
    expect(await tools.call("webhook.send", { event: "x" }).catch((e) => (e as ToolError).message)).toContain("public");
    expect(calls).toHaveLength(1);
  });
});

describe("plugins.manifest — HTTP contract", () => {
  const build = () => {
    const store = new MemoryStore();
    const tools = new ToolRegistry();
    const plugins = new PluginService({ store, tools });
    plugins.registerImplementation(notesPlugin());
    const chat = new ChatService(store, new Map([["mock", new MockProvider()]]), tools);
    const app = createApp({ store, chat, token: "t0ken", plugins });
    return { app, plugins, auth: { authorization: "Bearer t0ken" } };
  };

  test("the plugin list requires the bearer token", async () => {
    const { app } = build();
    expect((await app.request("/api/plugins")).status).toBe(401);
    const ok = await app.request("/api/plugins", { headers: { authorization: "Bearer t0ken" } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).plugins.map((p: any) => p.id)).toEqual(["github", "notes", "webhook"]);
  });

  test("enable without config is 409 with the missing field named", async () => {
    const { app, auth } = build();
    const r = await app.request("/api/plugins/notes/enable", { method: "POST", headers: auth });
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body.error.code).toBe("config_missing");
    expect(body.error.message).toContain("folder");
  });

  test("install, configure, enable, disable and uninstall over HTTP", async () => {
    const { app, auth } = build();
    const put = await app.request("/api/plugins/notes/config", {
      method: "PUT", headers: auth, body: JSON.stringify({ folder: "inbox" }),
    });
    expect(put.status).toBe(200);

    const enabled = await app.request("/api/plugins/notes/enable", { method: "POST", headers: auth });
    expect(enabled.status).toBe(200);
    expect((await enabled.json()).plugin.enabled).toBe(true);

    const disabled = await app.request("/api/plugins/notes/disable", { method: "POST", headers: auth });
    expect((await disabled.json()).plugin.enabled).toBe(false);

    const del = await app.request("/api/plugins/notes", { method: "DELETE", headers: auth });
    expect(del.status).toBe(200);
    expect((await app.request("/api/plugins/notes", { headers: auth })).status).toBe(404);
  });

  test("a malformed manifest is a 400 that names the problem", async () => {
    const { app, auth } = build();
    const r = await app.request("/api/plugins", {
      method: "POST", headers: auth, body: JSON.stringify({ id: "x", name: "", version: "1.0" }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error.message).toContain("version");
  });
});
