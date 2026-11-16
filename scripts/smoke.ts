/**
 * End-to-end smoke: boots the real server on an ephemeral port with a throwaway
 * home directory, then drives the same HTTP surface the React client uses.
 *
 *   bun run smoke          (builds the client first if dist/web is missing)
 *   bun run smoke --keep   (leave the temp home in place for inspection)
 *
 * Exits 0 only when every check passes and prints RESULT: PASS.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, VERSION } from "../src/server/main";

const TOKEN = "smoke-token";
const ROOT = join(import.meta.dir, "..");
const keep = process.argv.includes("--keep");

let failures = 0;
const results: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

async function buildWeb(): Promise<boolean> {
  if (existsSync(join(ROOT, "dist/web/index.html"))) return true;
  const proc = Bun.spawn(["bunx", "vite", "build"], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  return (await proc.exited) === 0;
}

async function readSse(res: Response): Promise<{ event: string; data: any }[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((block) => block.trim())
    .map((block) => {
      let event = "message";
      let data: any = undefined;
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7).trim();
        else if (line.startsWith("data: ")) {
          const raw = line.slice(6);
          try { data = JSON.parse(raw); } catch { data = raw; }
        }
      }
      return { event, data };
    });
}

async function main(): Promise<void> {
  console.log(`harness smoke — ${VERSION}`);

  check("web client is built", await buildWeb(), "dist/web/index.html");
  if (failures) return;

  const home = mkdtempSync(join(tmpdir(), "harness-smoke-"));
  const harness = await createHarness({ home, token: TOKEN, staticRoot: join(ROOT, "dist/web") });
  const server = Bun.serve({ port: 0, fetch: harness.app.fetch });
  const base = `http://127.0.0.1:${server.port}`;
  const auth = { authorization: `Bearer ${TOKEN}` };

  try {
    const health = await fetch(`${base}/health`).then((r) => r.json() as Promise<any>);
    check("health answers without a token", health.ok === true && health.version === VERSION);
    check("all capability modules are running", Array.isArray(health.modules) && health.modules.every((m: any) => m.state === "running"), `${health.modules?.length ?? 0} modules`);

    const index = await fetch(`${base}/`);
    const html = await index.text();
    check("index.html is served", index.status === 200 && html.includes('<div id="root">'));
    const asset = /src="([^"]+\.js)"/.exec(html)?.[1];
    const js = asset ? await fetch(`${base}${asset}`) : null;
    check("the client bundle is served from the same origin", Boolean(js && js.status === 200), asset ?? "no script tag");

    const deep = await fetch(`${base}/agents`);
    check("a deep link falls back to the SPA shell", deep.status === 200 && (await deep.text()).includes('<div id="root">'));

    const unknownApi = await fetch(`${base}/api/nope`, { headers: auth });
    check("an unknown API path is JSON 404, not the SPA shell", unknownApi.status === 404 && (await unknownApi.headers.get("content-type"))!.includes("json"));

    const noToken = await fetch(`${base}/api/agents`);
    check("API routes refuse a tokenless request", noToken.status === 401);

    const agents = await fetch(`${base}/api/agents`, { headers: auth }).then((r) => r.json() as Promise<any>);
    check("seed data provides two agents", agents.agents?.length === 2, agents.agents?.map((a: any) => a.name).join(", "));

    const conversations = await fetch(`${base}/api/conversations`, { headers: auth }).then((r) => r.json() as Promise<any>);
    check("seed data provides a conversation with history", conversations.conversations?.length >= 1);
    const convo = await fetch(`${base}/api/conversations/${conversations.conversations[0].id}`, { headers: auth }).then((r) => r.json() as Promise<any>);
    check("the seeded conversation has messages", convo.messages?.length >= 3, `${convo.messages?.length} messages`);

    const listing = await fetch(`${base}/api/files?path=.`, { headers: auth }).then((r) => r.json() as Promise<any>);
    const names = (listing.entries ?? []).map((e: any) => e.name);
    check("the workspace lists seeded files", listing.type === "dir" && names.includes("README.md") && names.includes("data"), names.join(", "));
    const readme = await fetch(`${base}/api/files?path=README.md`, { headers: auth }).then((r) => r.json() as Promise<any>);
    check("a file reads back through the API", readme.type === "file" && readme.content.includes("# Workspace"));

    const chat = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ message: "/tool fs.list {}" }),
    });
    const events = await readSse(chat);
    const kinds = events.map((e) => e.event);
    check("chat streams a tool call and its result", chat.status === 200 && kinds.includes("tool_call") && kinds.includes("tool_result") && kinds.includes("done"), kinds.join(" → "));

    const research = agents.agents.find((a: any) => a.name === "Research Assistant");
    const started = await fetch(`${base}/api/agents/${research.id}/runs`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ input: '/tool fs.search {"q": "Plugins"}' }),
    }).then((r) => r.json() as Promise<any>);
    check("an agent run is accepted", Boolean(started.runId));

    let run: any = null;
    for (let i = 0; i < 50; i++) {
      run = await fetch(`${base}/api/runs/${started.runId}`, { headers: auth }).then((r) => r.json() as Promise<any>).then((r) => r.run);
      if (run?.status !== "running") break;
      await Bun.sleep(100);
    }
    check("the run finishes successfully", run?.status === "succeeded", `${run?.status}, ${run?.steps?.length} steps`);
    check("the run records the tool step it executed", run?.steps?.some((s: any) => s.kind === "tool" && s.tool === "fs.search"));

    const plugins = await fetch(`${base}/api/plugins`, { headers: auth }).then((r) => r.json() as Promise<any>);
    check("built-in plugins are listed", plugins.plugins?.length === 2);
    const modules = await fetch(`${base}/api/modules`, { headers: auth }).then((r) => r.json() as Promise<any>);
    check("the module switchboard is listed", modules.modules?.length >= 3);

    const saved = await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ provider: "mock", model: "smoke-model" }),
    }).then((r) => r.json() as Promise<any>);
    check("settings round-trip", saved.settings?.provider === "mock" && saved.settings?.model === "smoke-model");

    const badSettings = await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ provider: "does-not-exist" }),
    });
    check("an unknown provider is rejected server-side", badSettings.status === 400);

    const escape = await fetch(`${base}/api/files?path=${encodeURIComponent("../../etc/passwd")}`, { headers: auth });
    check("a path escape is refused", escape.status === 400 || escape.status === 404, String(escape.status));
  } finally {
    server.stop(true);
    await harness.store.close();
    if (!keep) rmSync(home, { recursive: true, force: true });
  }
}

await main();
for (const line of results) console.log(line);
console.log(failures === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failures} check${failures === 1 ? "" : "s"})`);
process.exit(failures === 0 ? 0 : 1);
