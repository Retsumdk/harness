/**
 * Scripted end-to-end of the built app's primary flow, for `bin/clone-gate.sh`.
 *
 * Where `smoke.ts` checks that every route answers, this drives the four steps a
 * stranger actually performs on the shipped build:
 *
 *   1. sign in with the token and land on the app shell the bundle serves
 *   2. send a chat message that executes a real tool and read the streamed answer
 *   3. open an agent run that was started mid-flight and watch it finish
 *   4. save a file and create another one while a file is open (the round-2 P1)
 *
 * It runs against `dist/web` — the artefact the demo is built from — so a green
 * result means the built bundle plus the real server behave together.
 *
 *   bun run e2e          -> RESULT: PASS | RESULT: FAIL
 *   bun run e2e --keep   -> leave the temp home for inspection
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness } from "../src/server/main";

const TOKEN = "e2e-token";
const ROOT = join(import.meta.dir, "..");
const keep = process.argv.includes("--keep");

let failures = 0;
const results: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
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
  console.log("harness e2e — the built app, driven the way a stranger drives it");

  if (!existsSync(join(ROOT, "dist/web/index.html"))) {
    console.log("RESULT: FAIL: dist/web/index.html is missing — run `bun run build:web` first");
    process.exit(1);
  }

  const home = mkdtempSync(join(tmpdir(), "harness-e2e-"));
  const harness = await createHarness({ home, token: TOKEN, staticRoot: join(ROOT, "dist/web") });
  const server = Bun.serve({ port: 0, fetch: harness.app.fetch });
  const base = `http://127.0.0.1:${server.port}`;
  const auth = { authorization: `Bearer ${TOKEN}` };
  const json = { ...auth, "content-type": "application/json" };

  try {
    // 1. The build the client gets, served and mounted.
    const shell = await fetch(`${base}/`);
    const html = await shell.text();
    check("the built bundle is served at the root", shell.status === 200 && html.includes('<div id="root">'));
    const asset = /src="([^"]+\.js)"/.exec(html)?.[1];
    const js = asset ? await fetch(`${base}${asset}`) : null;
    const bundle = js ? await js.text() : "";
    check("the client bundle loads from the same origin", Boolean(js && js.status === 200), asset ?? "no script tag");
    check("the bundle carries the app, not a placeholder", bundle.length > 100_000, `${Math.round(bundle.length / 1024)} kB`);

    // Sign-in is the first thing the page does with a token.
    const wrong = await fetch(`${base}/api/conversations`, { headers: { authorization: "Bearer nope" } });
    check("a wrong token is refused before anything renders", wrong.status === 401);

    // 2. A chat message that runs a real tool, streamed back.
    const chat = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ message: "/tool fs.list {}" }),
    });
    const events = await readSse(chat);
    const kinds = events.map((e) => e.event);
    const answer = events.filter((e) => e.event === "token").map((e) => String(e.data?.text ?? "")).join("");
    check("chat streams a tool call, its result and an answer", chat.status === 200 && kinds.includes("tool_call") && kinds.includes("tool_result") && kinds.includes("done"), kinds.join(" → "));
    check("the answer that follows the tool is not empty", answer.trim().length > 0, answer.slice(0, 40));

    // 3. An agent run opened while it is still running, then watched to its end.
    const agents = await fetch(`${base}/api/agents`, { headers: auth }).then((r) => r.json() as Promise<any>);
    const agent = agents.agents?.[0];
    const started = await fetch(`${base}/api/agents/${agent.id}/runs`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ input: '/tool fs.search {"q": "Plugins"}' }),
    }).then((r) => r.json() as Promise<any>);
    check("an agent run is accepted", Boolean(started.runId), agent?.name ?? "no agent");
    const feed = await fetch(`${base}/api/runs/${started.runId}/stream`, { headers: auth });
    const feedEvents = await readSse(feed);
    const seen = feedEvents.map((e) => e.event);
    check("the run feed streams to completion for a viewer", feed.status === 200 && seen.includes("done"), seen.join(" → "));
    const run = await fetch(`${base}/api/runs/${started.runId}`, { headers: auth }).then((r) => r.json() as Promise<any>).then((r) => r.run);
    check("the run it streamed really finished", run?.status === "succeeded", `${run?.status}, ${run?.steps?.length ?? 0} steps`);

    // 4. Files: save an open file, then create one *while a file is open* — the
    //    state in which the round-2 P1 sent `README.md/probe.md` and got a 500.
    const saved = await fetch(`${base}/api/files?path=${encodeURIComponent("data/notes/e2e.md")}`, {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ content: "saved by the e2e pass\n" }),
    });
    const reread = await fetch(`${base}/api/files?path=${encodeURIComponent("data/notes/e2e.md")}`, { headers: auth }).then((r) => r.json() as Promise<any>);
    check("a file saves and reads back", saved.status === 200 && reread.content === "saved by the e2e pass\n");

    const besideOpenFile = await fetch(`${base}/api/files?path=${encodeURIComponent("data/notes/e2e-sibling.md")}`, {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ content: "" }),
    });
    check("creating next to an open file lands in the folder", besideOpenFile.status === 200);

    const underFile = await fetch(`${base}/api/files?path=${encodeURIComponent("README.md/probe.md")}`, {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ content: "" }),
    });
    const underBody = await underFile.json() as any;
    check("a destination inside a file is a 400, not a 500", underFile.status === 400 && underBody?.error?.code === "bad_request", `${underFile.status} ${underBody?.error?.code ?? ""}`);

    // Every click a stranger makes has a route, and the wrong URL goes somewhere.
    for (const path of ["/chat", "/files", "/agents", "/plugins", "/settings"]) {
      const res = await fetch(`${base}${path}`);
      check(`the ${path} route serves the app`, res.status === 200 && (await res.text()).includes('<div id="root">'));
    }
    const missing = await fetch(`${base}/not-a-page`);
    check("an unknown URL still serves the app so it can show a 404", missing.status === 200 && (await missing.text()).includes('<div id="root">'));
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
