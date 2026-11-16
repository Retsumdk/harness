/**
 * Perf gate for HARNESS.
 *
 * Two claims are measured, not asserted:
 *   1. Cold start — a fresh `bun src/server/main.ts` answers /health in under 1s,
 *      including database creation and first-run seeding.
 *   2. Concurrency — 100 simultaneous SSE chats all finish, all reach `done`,
 *      and resident memory stays under a fixed ceiling.
 *
 * Run: bun run perf        (or bash bin/perf-check.sh)
 * Prints a table and `RESULT: PASS` / `RESULT: FAIL`; exits 1 on failure.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness } from "../src/server/main";

const COLD_START_LIMIT_MS = 1000;
const COLD_START_RUNS = 3;
const CONCURRENT_CHATS = 100;
const CONCURRENT_LIMIT_MS = 10_000;
const RSS_CEILING_MB = 400;

const results: { name: string; ok: boolean; detail: string }[] = [];
function record(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"}  ${name.padEnd(28)} ${detail}`);
}

const rssMb = () => process.memoryUsage().rss / (1024 * 1024);

async function coldStart(attempt: number): Promise<number> {
  const home = mkdtempSync(join(tmpdir(), "harness-perf-cold-"));
  const started = performance.now();
  const child = Bun.spawn(["bun", "run", join(import.meta.dir, "../src/server/main.ts")], {
    env: {
      ...process.env,
      HARNESS_TOKEN: "perf-token",
      HARNESS_HOME: home,
      HARNESS_PORT: "0",
      HARNESS_WEB_DIST: join(home, "no-build"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const port = await firstPort(child, started);
    const elapsed = performance.now() - started;
    if (!port) throw new Error(`server never reported a port (attempt ${attempt})`);
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    if (!health.ok) throw new Error(`/health answered ${health.status}`);
    const body = (await health.json()) as { ok?: boolean };
    if (!body.ok) throw new Error("/health did not report ok");
    return performance.now() - started;
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    rmSync(home, { recursive: true, force: true });
  }
}

/** Reads the child's stdout until it logs its listening URL, already elapsed. */
async function firstPort(
  child: { stdout: ReadableStream<Uint8Array> | number | undefined | null },
  since: number,
): Promise<number | null> {
  const out = child.stdout;
  if (!out || typeof out === "number") return null;
  const reader = out.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const deadline = Date.now() + COLD_START_LIMIT_MS * 5;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const m = /localhost:(\d+)/.exec(buffered);
    if (m && performance.now() - since >= 0) return Number(m[1]);
  }
  return null;
}

async function concurrency(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "harness-perf-load-"));
  const harness = await createHarness({ home, token: "perf-token", seed: false });
  const server = Bun.serve({ port: 0, fetch: harness.app.fetch });
  const url = `http://127.0.0.1:${server.port}/api/chat`;
  const baseRss = rssMb();
  let peak = baseRss;
  const sampler = setInterval(() => { peak = Math.max(peak, rssMb()); }, 25);
  const started = performance.now();
  try {
    const outcomes = await Promise.all(
      Array.from({ length: CONCURRENT_CHATS }, async (_, i) => {
        const res = await fetch(url, {
          method: "POST",
          headers: { authorization: "Bearer perf-token", "content-type": "application/json" },
          body: JSON.stringify({ message: `stream ${i} says hello` }),
        });
        if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
        const text = await res.text();
        return { ok: text.includes("event: done") && text.includes("event: token"), why: "no token/done events" };
      }),
    );
    const elapsed = performance.now() - started;
    peak = Math.max(peak, rssMb());
    const failed = outcomes.filter((o) => !o.ok);
    record(
      `${CONCURRENT_CHATS} concurrent chats`,
      failed.length === 0 && elapsed < CONCURRENT_LIMIT_MS,
      `${failed.length} failed, ${elapsed.toFixed(0)}ms total (limit ${CONCURRENT_LIMIT_MS}ms)` +
        (failed.length ? ` — first: ${failed[0].why}` : ""),
    );
    record(
      "memory under load",
      peak - baseRss < RSS_CEILING_MB,
      `+${(peak - baseRss).toFixed(0)}MB over ${CONCURRENT_CHATS} streams (ceiling ${RSS_CEILING_MB}MB), peak rss ${peak.toFixed(0)}MB`,
    );
    record(
      "store written by all chats",
      (await harness.store.listConversations()).length === CONCURRENT_CHATS,
      `${(await harness.store.listConversations()).length} conversations persisted`,
    );
  } finally {
    clearInterval(sampler);
    server.stop(true);
    await harness.store.close();
    rmSync(home, { recursive: true, force: true });
  }
}

const timings: number[] = [];
for (let i = 1; i <= COLD_START_RUNS; i++) {
  try {
    timings.push(await coldStart(i));
  } catch (e) {
    record("cold start", false, `attempt ${i}: ${(e as Error).message}`);
  }
}
if (timings.length === COLD_START_RUNS) {
  const worst = Math.max(...timings);
  record(
    "cold start to /health 200",
    worst < COLD_START_LIMIT_MS,
    `runs ${timings.map((t) => t.toFixed(0)).join("/")}ms, worst ${worst.toFixed(0)}ms (limit ${COLD_START_LIMIT_MS}ms)`,
  );
}

await concurrency();

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length) {
  console.log(`RESULT: FAIL — ${failed.length} of ${results.length} checks failed`);
  process.exit(1);
}
console.log(`RESULT: PASS — ${results.length} checks`);
