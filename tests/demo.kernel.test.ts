import { describe, expect, test } from "bun:test";
import { DEMO_TOKEN, createDemoKernel } from "../src/demo/kernel";
import type { StorageLike } from "../src/demo/store";

/** A localStorage stand-in: the demo persists its store, and a reload is just a
 *  second kernel built over the same storage. */
function fakeStorage(): StorageLike & { dump: () => Record<string, string> } {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
    dump: () => Object.fromEntries(data),
  };
}

const call = async (kernel: Awaited<ReturnType<typeof createDemoKernel>>, path: string, init: RequestInit = {}) => {
  const res = await kernel.app.fetch(
    new Request(`https://demo.local${path}`, {
      ...init,
      headers: { authorization: `Bearer ${DEMO_TOKEN}`, "content-type": "application/json", ...(init.headers ?? {}) },
    }),
  );
  return { status: res.status, body: (await res.json()) as any };
};

describe("demo kernel — the static build's in-tab server", () => {
  test("seeds a workspace a stranger can understand from one screen", async () => {
    const kernel = await createDemoKernel({ storage: fakeStorage(), tokenDelayMs: 0 });
    expect(kernel.seed.seeded).toBe(true);
    expect(kernel.workspace.paths()).toEqual(["README.md", "data/releases.csv", "notes/onboarding.md"]);

    const files = await call(kernel, "/api/files?path=/");
    expect(files.status).toBe(200);
    const names = (files.body.entries as Array<{ name: string }>).map((e) => e.name);
    expect(names).toContain("README.md");
    expect(names).toContain("notes");

    const agents = await call(kernel, "/api/agents");
    expect((agents.body.agents as unknown[]).length).toBe(2);
  });

  test("a reload keeps the store but puts the seed files back", async () => {
    const storage = fakeStorage();
    const first = await createDemoKernel({ storage, tokenDelayMs: 0 });
    first.workspace.write("notes/scratch.md", "left behind by a visitor");

    const second = await createDemoKernel({ storage, tokenDelayMs: 0 });
    expect(second.seed.seeded).toBe(false);
    expect(second.workspace.paths()).toEqual(["README.md", "data/releases.csv", "notes/onboarding.md"]);
    const agents = await call(second, "/api/agents");
    expect((agents.body.agents as unknown[]).length).toBe(2);
  });

  test("refuses a request without the demo token", async () => {
    const kernel = await createDemoKernel({ storage: fakeStorage(), tokenDelayMs: 0 });
    const res = await kernel.app.fetch(new Request("https://demo.local/api/agents"));
    expect(res.status).toBe(401);
  });

  test("chat streams an answer and a tool call runs against the tab's workspace", async () => {
    const kernel = await createDemoKernel({ storage: fakeStorage(), tokenDelayMs: 0 });
    const conv = await kernel.store.createConversation("Demo");

    const res = await kernel.app.fetch(
      new Request("https://demo.local/api/chat", {
        method: "POST",
        headers: { authorization: `Bearer ${DEMO_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ conversationId: conv.id, message: '/tool fs.list {"path": "notes"}' }),
      }),
    );
    const text = await res.text();
    expect(text).toContain("tool");
    expect(text).toContain("onboarding.md");
  });
});
const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { authorization: `Bearer ${DEMO_TOKEN}`, "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

/** Every route family that changes state, driven through the in-tab kernel. The
 *  static demo is a separate build; a route that works under Bun can still break
 *  in a browser tab (both round-1 P1s were exactly that). These run in the same
 *  runtime the demo ships, so a Node-only global or a stalled stream fails here
 *  first. */
describe("demo kernel — the routes the demo's UI writes through", () => {
  test("files: save an existing file, create a new one, read both back, delete", async () => {
    const kernel = await createDemoKernel({ storage: fakeStorage(), tokenDelayMs: 0 });

    const saved = await call(kernel, "/api/files?path=data/releases.csv", json("PUT", { content: "version,date\n0.5.0,2026-11-16\n" }));
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ ok: true, path: "data/releases.csv" });
    expect(saved.body.size).toBe(new TextEncoder().encode("version,date\n0.5.0,2026-11-16\n").length);

    // Multi-byte content, which is where a byte length and a string length differ.
    const created = await call(kernel, "/api/files?path=notes/qa-probe.md", json("PUT", { content: "hallo ✓" }));
    expect(created.status).toBe(200);
    expect(created.body.size).toBe(9);

    const read = await call(kernel, "/api/files?path=notes/qa-probe.md");
    expect(read.body).toMatchObject({ type: "file", content: "hallo ✓", size: 9 });

    const removed = await call(kernel, "/api/files?path=notes/qa-probe.md", json("DELETE"));
    expect(removed.status).toBe(200);
    expect(kernel.workspace.paths()).not.toContain("notes/qa-probe.md");
  }, 10000);

  test("an agent run watched from mid-flight streams to done and succeeded", async () => {
    const kernel = await createDemoKernel({ storage: fakeStorage(), tokenDelayMs: 20 });
    const list = await call(kernel, "/api/agents");
    const agent = (list.body.agents as Array<{ id: string }>)[0];

    const started = await call(kernel, `/api/agents/${agent.id}/runs`, json("POST", { input: "/tool fs.list {}" }));
    expect(started.status).toBe(202);
    const runId = started.body.runId as string;

    // Open the feed the way the run viewer does: while the run is still going.
    let openedWhileRunning = false;
    const cutoff = Date.now() + 2000;
    while (Date.now() < cutoff) {
      const current = await call(kernel, `/api/runs/${runId}`);
      if (current.body.run.status === "running") { openedWhileRunning = true; break; }
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(openedWhileRunning).toBe(true);

    const res = await kernel.app.fetch(
      new Request(`https://demo.local/api/runs/${runId}/stream`, { headers: { authorization: `Bearer ${DEMO_TOKEN}` } }),
    );
    const text = await res.text();

    expect(text).toContain("event: step");
    expect(text).toContain("event: done");
    expect(text).toContain('"status":"succeeded"');

    const finished = await call(kernel, `/api/runs/${runId}`);
    expect(finished.body.run.status).toBe("succeeded");
    expect((finished.body.run.steps as unknown[]).length).toBeGreaterThan(0);
  }, 15000);

  test("plugins: install a manifest, enable it with config, uninstall it", async () => {
    const kernel = await createDemoKernel({ storage: fakeStorage(), tokenDelayMs: 0 });
    const manifest = {
      id: "webhook",
      name: "Webhook",
      version: "1.0.0",
      description: "POST signed JSON events to an external public endpoint.",
      permissions: ["network", "secrets"],
      config: [{ name: "url", type: "string", required: true, description: "Destination URL." }],
      tools: [{ name: "webhook.send", description: "Send an event.", schema: { type: "object", properties: { event: { type: "string" } }, required: ["event"] } }],
    };

    const installed = await call(kernel, "/api/plugins", json("POST", manifest));
    expect(installed.status).toBe(201);
    expect(installed.body.plugin).toMatchObject({ id: "webhook", enabled: false });

    const configured = await call(kernel, "/api/plugins/webhook/config", json("PUT", { url: "https://example.com/hook" }));
    expect(configured.status).toBe(200);
    expect(configured.body.plugin.missingRequired).toEqual([]);

    const enabled = await call(kernel, "/api/plugins/webhook/enable", json("POST"));
    expect(enabled.status).toBe(200);
    expect(enabled.body.plugin.enabled).toBe(true);

    const tools = await call(kernel, "/api/settings");
    expect(tools.body.tools as string[]).toContain("webhook.send");

    // The same order the Plugins page enforces: a running plugin cannot be removed.
    const removedWhileEnabled = await call(kernel, "/api/plugins/webhook", json("DELETE"));
    expect(removedWhileEnabled.status).toBe(409);
    expect(removedWhileEnabled.body.error.code).toBe("conflict");

    const disabled = await call(kernel, "/api/plugins/webhook/disable", json("POST"));
    expect(disabled.status).toBe(200);
    expect(disabled.body.plugin.enabled).toBe(false);

    const removed = await call(kernel, "/api/plugins/webhook", json("DELETE"));
    expect(removed.status).toBe(200);
    // Uninstalled built-ins stay listed as available (installed: false), so the
    // Pages UI can offer them again; the store record is what disappears.
    const after = (await call(kernel, "/api/plugins")).body.plugins as Array<{ id: string; installed: boolean; enabled: boolean }>;
    expect(after.find((p) => p.id === "webhook")).toMatchObject({ installed: false, enabled: false });
  }, 10000);

  test("stopping a module takes its routes offline with a recovery hint that names the right screen", async () => {
    const kernel = await createDemoKernel({ storage: fakeStorage(), tokenDelayMs: 0 });

    const stopped = await call(kernel, "/api/modules/agents/disable", json("POST"));
    expect(stopped.status).toBe(200);
    expect(stopped.body.module.state).not.toBe("running");

    const blocked = await kernel.app.fetch(
      new Request("https://demo.local/api/agents", { headers: { authorization: `Bearer ${DEMO_TOKEN}` } }),
    );
    expect(blocked.status).toBe(409);
    const body = (await blocked.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("module_disabled");
    expect(body.error.message).toContain("Plugins");
    expect(body.error.message).toContain("Capability modules");

    await call(kernel, "/api/modules/agents/enable", json("POST"));
    expect((await call(kernel, "/api/agents")).status).toBe(200);
  }, 10000);
});

describe("demo kernel — no Node-only globals in the modules the tab ships", () => {
  // The static demo runs the real routes and services in a page. A Node global that
  // the test runtime happens to provide (`Buffer`, `process`) type-checks and passes
  // here, then throws in the browser: that is exactly how round 1 shipped
  // `Buffer.byteLength` in PUT /api/files and broke every save in the demo.
  const TAB_MODULES = [
    "src/demo",
    "src/web",
    "src/server/app.ts",
    "src/server/routes-workspace.ts",
    "src/server/routes-plugins.ts",
    "src/server/seed.ts",
    "src/tools/fs-tools.ts",
    "src/providers/mock.ts",
    "src/chat",
    "src/agents",
    "src/plugins",
    "src/core",
  ];
  // Server-only by design: the disk workspace and the sandboxed shell never reach a tab.
  const SERVER_ONLY = ["src/fs/workspace.ts", "src/tools/shell.ts"];

  test("nothing the browser runs reaches for Buffer or process", async () => {
    const glob = new Bun.Glob("{**/*.ts,**/*.tsx}");
    const offenders: string[] = [];
    for (const entry of TAB_MODULES) {
      const files = entry.endsWith(".ts") ? [entry] : [...glob.scanSync({ cwd: entry })].map((f) => `${entry}/${f}`);
      for (const file of files) {
        if (SERVER_ONLY.includes(file)) continue;
        const text = await Bun.file(file).text();
        text.split("\n").forEach((line, i) => {
          if (/\bBuffer\s*\.|\bprocess\s*\.\s*(env|argv|exit|cwd)\b/.test(line)) {
            offenders.push(`${file}:${i + 1} — ${line.trim()}`);
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("demo kernel — a destination under a file is refused, not stored", () => {
  test("creating a file under an existing file is a 400 in the tab, like the server", async () => {
    const kernel = await createDemoKernel({ storage: fakeStorage(), tokenDelayMs: 0 });
    const res = await call(kernel, `/api/files?path=${encodeURIComponent("README.md/probe.md")}`, {
      method: "PUT",
      body: JSON.stringify({ content: "" }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
    expect(kernel.workspace.paths()).toEqual(["README.md", "data/releases.csv", "notes/onboarding.md"]);
  });
});
