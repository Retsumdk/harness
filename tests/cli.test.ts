import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness } from "../src/server/main";
import { parseArgs, runCli, USAGE } from "../src/cli/run";

const TOKEN = "cli-test-token";

/** Every command runs against the real app object, so the CLI is proven against the
 *  same routes the web client uses — no second, made-up contract. */
const home = mkdtempSync(join(tmpdir(), "harness-cli-"));
const harness = await createHarness({ home, token: TOKEN, seed: true });

const fetchImpl = (input: string, init?: RequestInit): Promise<Response> =>
  Promise.resolve(harness.app.fetch(new Request(new URL(input, "http://cli.local"), init)));

function cli(args: string[], env: Record<string, string | undefined> = {}) {
  let out = "";
  let err = "";
  const code = runCli(args, {
    stdout: (t) => { out += t; },
    stderr: (t) => { err += t; },
    env: { HARNESS_TOKEN: TOKEN, HARNESS_URL: "http://cli.local", ...env },
    fetchImpl,
    sleep: async () => { await new Promise((r) => setTimeout(r, 1)); },
  });
  return code.then((exitCode) => ({ exitCode, out, err }));
}

afterAll(() => { rmSync(home, { recursive: true, force: true }); });

describe("argument parsing", () => {
  test("separates the command, positionals and flags", () => {
    const parsed = parseArgs(["chat", "hello", "there", "--json", "--model", "gpt-x", "--conversation", "conv_1"]);
    expect(parsed.command).toBe("chat");
    expect(parsed.positionals).toEqual(["hello", "there"]);
    expect(parsed.flags).toEqual({ json: true, model: "gpt-x", conversation: "conv_1" });
  });

  test("a message that looks like a flag survives after --", () => {
    const parsed = parseArgs(["chat", "--", "--not-a-flag for the model"]);
    expect(parsed.positionals).toEqual(["--not-a-flag for the model"]);
  });

  test("an unknown flag is rejected instead of being silently dropped", () => {
    expect(() => parseArgs(["ls", "--verbose"])).toThrow(/unknown flag/);
  });

  test("a flag missing its value is rejected", () => {
    expect(() => parseArgs(["ls", "--model"])).toThrow(/needs a value/);
  });
});

describe("usage and exit codes", () => {
  test("no command prints usage and exits 2", async () => {
    const r = await cli([]);
    expect(r.exitCode).toBe(2);
    expect(r.out).toContain(USAGE);
  });

  test("--help prints usage and exits 0", async () => {
    const r = await cli(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("harness run-agent");
  });

  test("an unknown command names the mistake and exits 2", async () => {
    const r = await cli(["frobnicate"]);
    expect(r.exitCode).toBe(2);
    expect(r.err).toContain('unknown command "frobnicate"');
  });

  test("a missing token is caught before any request is made", async () => {
    const r = await cli(["health"], { HARNESS_TOKEN: "" });
    expect(r.exitCode).toBe(2);
    expect(r.err).toContain("HARNESS_TOKEN");
  });
});

describe("health and ls", () => {
  test("health reports the instance and its modules", async () => {
    const r = await cli(["health"]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("HARNESS 0.1.0");
    expect(r.out).toContain("running");
  });

  test("health --json is one parseable object", async () => {
    const r = await cli(["health", "--json"]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.out).ok).toBe(true);
  });

  test("ls lists the seeded workspace, directories first", async () => {
    const r = await cli(["ls"]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("README.md");
    expect(r.out).toContain("data/");
  });

  test("ls on a file prints the file instead of a directory error", async () => {
    const r = await cli(["ls", "data/releases.csv"]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("0.4.0,2026-11-13");
  });

  test("ls on a missing path exits 1 with the server's message", async () => {
    const r = await cli(["ls", "nope"]);
    expect(r.exitCode).toBe(1);
    expect(r.err).toContain("no such directory: nope");
  });

  test("a rejected token explains itself instead of printing a stack", async () => {
    const r = await cli(["ls"], { HARNESS_TOKEN: "wrong" });
    expect(r.exitCode).toBe(1);
    expect(r.err).toContain("access token rejected");
  });
});

describe("chat", () => {
  test("streams the reply and reports the conversation id", async () => {
    const r = await cli(["chat", "hello", "harness"]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("You said: hello harness");
    expect(r.out).toMatch(/conversation: conv_[a-z0-9]+/);
  });

  test("a tool request runs the real tool and shows its result", async () => {
    const r = await cli(["chat", "/tool fs.list {}"]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("[tool] fs.list");
    expect(r.out).toContain("[result]");
    expect(r.out).toContain("README.md");
  });

  test("--conversation continues an existing conversation", async () => {
    const first = await cli(["chat", "first turn", "--json"]);
    const conversationId = JSON.parse(first.out).conversationId as string;
    const second = await cli(["chat", "second turn", "--conversation", conversationId]);
    expect(second.exitCode).toBe(0);
    expect(second.out).toContain(`conversation: ${conversationId}`);
  });

  test("an unknown provider is a usage error, not a crash", async () => {
    const r = await cli(["chat", "hi", "--provider", "nope"]);
    expect(r.exitCode).toBe(1);
    expect(r.err).toContain('unknown provider "nope"');
  });
});

describe("agents and runs", () => {
  test("agents lists the seeded definitions with their ids", async () => {
    const r = await cli(["agents"]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("Research Assistant");
    expect(r.out).toContain("Release Note Writer");
    expect(r.out).toMatch(/agent_[a-z0-9]+/);
  });

  test("run-agent accepts a name and follows the run to its output", async () => {
    const r = await cli(["run-agent", "Research Assistant", "/tool fs.list {}"]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("-> running");
    expect(r.out).toContain("-> succeeded");
    expect(r.out).toContain("Tool result");
  });

  test("run-agent accepts an unambiguous id prefix", async () => {
    const list = await cli(["agents", "--json"]);
    const agents = JSON.parse(list.out) as { id: string; name: string }[];
    const target = agents.find((a) => a.name === "Release Note Writer")!;
    const r = await cli(["run-agent", target.id.slice(0, 12), "Summarise the releases."]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("-> succeeded");
  });

  test("an unknown agent name lists what does exist", async () => {
    const r = await cli(["run-agent", "Nobody", "do a thing"]);
    expect(r.exitCode).toBe(2);
    expect(r.err).toContain('no agent matches "Nobody"');
    expect(r.err).toContain("Research Assistant");
  });

  test("run-agent without a task is a usage error", async () => {
    const r = await cli(["run-agent", "Research Assistant"]);
    expect(r.exitCode).toBe(2);
    expect(r.err).toContain("run-agent needs an agent");
  });
});

describe("files and plugins", () => {
  test("files cat reads, files write writes, cat reads the write back", async () => {
    const write = await cli(["files", "write", "notes/cli.md", "--content", "written by the CLI"]);
    expect(write.exitCode).toBe(0);
    const read = await cli(["files", "cat", "notes/cli.md"]);
    expect(read.out).toContain("written by the CLI");
  });

  test("files search finds text and prints a path:line", async () => {
    const r = await cli(["files", "search", "sandboxed"]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toMatch(/notes\/onboarding\.md:2/);
  });

  test("files rm reports what it deleted, and cat afterwards fails", async () => {
    const rm = await cli(["files", "rm", "notes/cli.md"]);
    expect(rm.exitCode).toBe(0);
    expect(rm.out).toContain("deleted notes/cli.md");
    const read = await cli(["files", "cat", "notes/cli.md"]);
    expect(read.exitCode).toBe(1);
  });

  test("files with an unknown subcommand prints the file usage", async () => {
    const r = await cli(["files", "chmod", "x"]);
    expect(r.exitCode).toBe(2);
    expect(r.err).toContain("files cat");
  });

  test("plugins lists the built-ins as inert until configured", async () => {
    const r = await cli(["plugins"]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("github");
    expect(r.out).toContain("webhook");
    expect(r.out).toContain("disabled");
  });

  test("plugins --disable on an uninstalled plugin is a clean error", async () => {
    const r = await cli(["plugins", "--disable", "webhook"]);
    expect(r.exitCode).toBe(1);
    expect(r.err.length).toBeGreaterThan(0);
  });
});

describe("transport failures", () => {
  test("an unreachable server says so once, with the URL it tried", async () => {
    let out = "";
    let err = "";
    const exitCode = await runCli(["health"], {
      stdout: (t) => { out += t; },
      stderr: (t) => { err += t; },
      env: { HARNESS_TOKEN: TOKEN, HARNESS_URL: "http://127.0.0.1:1" },
    });
    expect(exitCode).toBe(1);
    expect(err).toContain("cannot reach the harness server");
    expect(out).toBe("");
  });
});
