/**
 * The `harness` CLI. Every command is a thin client of the HTTP API, so the
 * terminal, the browser and any script see the same product with the same
 * permissions. No command reaches into the server's internals.
 *
 *   harness health
 *   harness chat "hello" [--conversation <id>] [--provider mock] [--model <m>]
 *   harness agents
 *   harness run-agent <id|name> "<task>" [--follow]
 *   harness ls [path]
 *   harness files cat|write|rm|search <args>
 *   harness plugins [--enable <id>] [--disable <id>]
 *
 * Global flags: --base <url>, --token <token>, --json.
 * The token is never required as a flag: HARNESS_TOKEN is the normal source.
 */
import {
  ApiError, HarnessApi, NetworkError, UnauthorizedError, describeError,
  type AgentRun, type ChatEvent, type FileEntry, type ModuleView, type RunStep,
} from "../web/api";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  /** Injected by tests; production uses the global fetch. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  readStdin?: () => Promise<string>;
  /** Pause between run polls; tests pass 0 so the suite stays fast. */
  sleep?: (ms: number) => Promise<void>;
  /** Told to the client how long a run may take before the CLI gives up. */
  runTimeoutMs?: number;
}

interface Flags { [k: string]: string | boolean }

export interface Parsed { command: string; positionals: string[]; flags: Flags }

const GLOBAL_FLAGS = new Set(["base", "token", "json", "follow", "help", "conversation", "provider", "model", "enable", "disable", "content"]);
const BOOLEAN_FLAGS = new Set(["json", "follow", "help"]);
const VALUE_FLAGS = new Set(["base", "token", "conversation", "provider", "model", "enable", "disable", "content"]);

export class UsageError extends Error {}

/** Splits argv into a command, positional args and `--flag` / `--flag value`. */
export function parseArgs(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") { positionals.push(...argv.slice(i + 1)); break; }
    if (token.startsWith("--")) {
      const name = token.slice(2);
      if (!name) throw new UsageError("empty flag name");
      if (!GLOBAL_FLAGS.has(name)) throw new UsageError(`unknown flag "--${name}"`);
      if (BOOLEAN_FLAGS.has(name)) { flags[name] = true; continue; }
      const value = argv[i + 1];
      if (value === undefined || (value.startsWith("--") && VALUE_FLAGS.has(value.slice(2)))) {
        throw new UsageError(`--${name} needs a value`);
      }
      flags[name] = value;
      i++;
      continue;
    }
    positionals.push(token);
  }
  const [command = "", ...rest] = positionals;
  return { command, positionals: rest, flags };
}

export const USAGE = `harness — command line for the workspace

  harness health                        server status, version and module states
  harness chat "<message>"              one streamed turn; --conversation <id> to continue
  harness agents                        list agent definitions
  harness run-agent <id|name> "<task>"  start a run, follow it, print the output
  harness ls [path]                     list workspace files (a file prints its content)
  harness files cat <path>              print a file
  harness files write <path> --content "<text>"   write a file ("-" reads stdin)
  harness files rm <path>               delete a file
  harness files search <query>          search workspace text
  harness plugins                       plugin list; --enable/--disable <id>

  --base <url>    server URL (default $HARNESS_URL or http://localhost:8787)
  --token <t>     access token (default $HARNESS_TOKEN)
  --json          machine-readable output
`;

const isJson = (flags: Flags) => flags.json === true;

function table(rows: string[][], headers: string[]): string {
  const all = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  return all
    .map((r) => r.map((cell, i) => (cell ?? "").padEnd(widths[i])).join("  ").trimEnd())
    .join("\n");
}

const ms = (n: number) => `${Math.max(0, Math.round(n))}ms`;

/** Resolves an agent by exact id, id prefix, exact name, or unique name prefix. */
async function resolveAgent(api: HarnessApi, needle: string) {
  const agents = await api.listAgents();
  const lower = needle.toLowerCase();
  const exact = agents.find((a) => a.id === needle)
    ?? agents.find((a) => a.name.toLowerCase() === lower)
    ?? agents.find((a) => a.id.startsWith(needle));
  if (exact) return exact;
  const prefixed = agents.filter((a) => a.name.toLowerCase().startsWith(lower));
  if (prefixed.length === 1) return prefixed[0];
  if (prefixed.length > 1) {
    throw new UsageError(`"${needle}" matches ${prefixed.length} agents: ${prefixed.map((a) => `${a.name} (${a.id})`).join(", ")}`);
  }
  throw new UsageError(`no agent matches "${needle}"${agents.length ? ` — try: ${agents.map((a) => a.name).join(", ")}` : " — there are no agents yet"}`);
}

function describeStep(step: RunStep): string {
  if (step.kind === "assistant") return `[${step.index}] model: ${step.text.replace(/\s+/g, " ").slice(0, 240)}`;
  const args = Object.keys(step.args ?? {}).length ? ` ${JSON.stringify(step.args)}` : "";
  if (step.error) return `[${step.index}] tool ${step.tool}${args} → error: ${step.error}`;
  const result = step.result === undefined ? "" : ` → ${typeof step.result === "string" ? step.result : JSON.stringify(step.result)}`;
  return `[${step.index}] tool ${step.tool}${args}${result.length > 300 ? `${result.slice(0, 300)}…` : result}`;
}

const TERMINAL = new Set<AgentRun["status"]>(["succeeded", "failed", "cancelled", "budget_exceeded"]);

/** Starts a run and polls it to completion, printing each new step and status once. */
async function followRun(api: HarnessApi, runId: string, io: CliIo): Promise<AgentRun> {
  const pause = io.sleep ?? ((n: number) => new Promise<void>((r) => setTimeout(r, n)));
  const timeout = io.runTimeoutMs ?? 60_000;
  const deadline = Date.now() + timeout;
  let printed = 0;
  let seen = "";
  let run = await api.getRun(runId);
  for (;;) {
    if (run.status !== seen) { io.stdout(`status -> ${run.status}\n`); seen = run.status; }
    for (const step of run.steps.slice(printed)) io.stdout(`${describeStep(step)}\n`);
    printed = run.steps.length;
    if (TERMINAL.has(run.status)) return run;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not finish within ${Math.round(timeout / 1000)}s (still ${run.status}); open /runs/${runId} to watch it`);
    await pause(25);
    run = await api.getRun(runId);
  }
}

const fileLine = (entry: FileEntry) =>
  entry.kind === "dir" ? `${entry.path}/` : `${entry.path}${entry.size === undefined ? "" : `  ${entry.size}B`}`;

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const out = (s: string) => io.stdout(s.endsWith("\n") ? s : `${s}\n`);
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    io.stderr(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { command, positionals, flags } = parsed;
  if (flags.help) { io.stdout(USAGE); return 0; }
  if (!command) { io.stdout(USAGE); return 2; }
  if (command === "version") { io.stdout("harness 0.1.0\n"); return 0; }

  const base = ((flags.base as string) ?? io.env.HARNESS_URL ?? "http://localhost:8787").replace(/\/$/, "");
  const token = (flags.token as string) ?? io.env.HARNESS_TOKEN ?? "";
  if (!token.trim()) {
    io.stderr("HARNESS_TOKEN is not set: export the token the server was started with, or pass --token.\n");
    return 2;
  }
  const api = new HarnessApi({ baseUrl: base, token, fetchImpl: io.fetchImpl });

  try {
    switch (command) {
      case "health": {
        const health = await api.health();
        if (isJson(flags)) { io.stdout(`${JSON.stringify(health)}\n`); return 0; }
        const modules = (health.modules ?? []) as ModuleView[];
        out(`HARNESS ${health.version}  ${health.ok ? "ok" : "degraded"}`);
        out(`url        ${base}`);
        out(`modules    ${modules.length}`);
        for (const m of modules) out(`  ${m.id.padEnd(12)} ${m.state}`);
        return 0;
      }

      case "chat": {
        const message = positionals.join(" ").trim();
        if (!message) throw new UsageError('chat needs a message: harness chat "what is in the workspace?"');
        let conversationId = (flags.conversation as string) ?? undefined;
        let errored = false;
        const quiet = isJson(flags);
        const id = await api.chat(
          { message, conversationId, provider: flags.provider as string | undefined, model: flags.model as string | undefined },
          {
            onEvent: (event: ChatEvent) => {
              if (event.type === "token") { if (!quiet) io.stdout(event.text); }
              else if (event.type === "tool_call") { if (!quiet) io.stdout(`\n[tool] ${event.call.name} ${JSON.stringify(event.call.args)}\n`); }
              else if (event.type === "tool_result") { if (!quiet) io.stdout(`[result] ${event.error ? `error: ${event.error}` : JSON.stringify(event.result)}\n`); }
              else if (event.type === "error") { errored = true; io.stderr(`\nerror: ${event.message}\n`); }
              else if (event.type === "done") conversationId = event.conversationId;
            },
          },
        );
        if (quiet) { io.stdout(`${JSON.stringify({ conversationId: id ?? conversationId, errored })}\n`); return errored ? 1 : 0; }
        out("");
        if (id ?? conversationId) out(`conversation: ${id ?? conversationId}`);
        return errored ? 1 : 0;
      }

      case "agents": {
        const agents = await api.listAgents();
        if (isJson(flags)) { io.stdout(`${JSON.stringify(agents)}\n`); return 0; }
        if (!agents.length) { out("No agents yet. Create one in the Agents tab, then run it here with: harness run-agent <name> \"<task>\""); return 0; }
        out(table(agents.map((a) => [a.id, a.name, a.provider, String(a.maxSteps), a.tools.join(",")]), ["id", "name", "provider", "steps", "tools"]));
        return 0;
      }

      case "run-agent": {
        const [who, ...rest] = positionals;
        const task = rest.join(" ").trim();
        if (!who || !task) throw new UsageError('run-agent needs an agent and a task: harness run-agent "Research Assistant" "find the release notes"');
        const agent = await resolveAgent(api, who);
        const runId = await api.startRun(agent.id, task);
        if (!isJson(flags)) io.stdout(`run ${runId} — ${agent.name}\n`);
        const run = await followRun(api, runId, io);
        if (isJson(flags)) {
          io.stdout(`${JSON.stringify({ runId: run.id, status: run.status, output: run.output, steps: run.steps.length, tokens: run.tokensUsed })}\n`);
        } else {
          out("");
          out(`steps     ${run.steps.length}`);
          out(`tokens    ${run.tokensUsed}`);
          out(`time      ${ms((run.endedAt ?? Date.now()) - run.startedAt)}`);
          if (run.error) out(`error     ${run.error}`);
          out("");
          out(run.output.trim() || "(no output)");
        }
        return run.status === "succeeded" ? 0 : 1;
      }

      case "ls": {
        const path = positionals[0] ?? ".";
        let entry;
        try {
          entry = await api.files(path);
        } catch (e) {
          if (e instanceof ApiError && e.code === "not_found") { io.stderr(`no such directory: ${path}\n`); return 1; }
          throw e;
        }
        if (entry.type === "file") {
          io.stdout(entry.content.endsWith("\n") ? entry.content : `${entry.content}\n`);
          return 0;
        }
        if (isJson(flags)) { io.stdout(`${JSON.stringify(entry.entries)}\n`); return 0; }
        if (!entry.entries.length) { out(`${path} is empty.`); return 0; }
        for (const item of entry.entries) out(fileLine(item));
        return 0;
      }

      case "files": {
        const [sub, ...rest] = positionals;
        if (sub === "cat") {
          if (!rest[0]) throw new UsageError("files cat needs a path");
          const file = await api.files(rest[0]);
          if (file.type !== "file") throw new UsageError(`${rest[0]} is a directory — try: harness ls ${rest[0]}`);
          io.stdout(file.content.endsWith("\n") ? file.content : `${file.content}\n`);
          return 0;
        }
        if (sub === "write") {
          if (!rest[0]) throw new UsageError('files write needs a path: harness files write notes/x.md --content "text"');
          const flagged = flags.content as string | undefined;
          const fromStdin = io.readStdin ?? (() => Promise.resolve(""));
          const content = flagged === "-" || flagged === undefined ? await fromStdin() : flagged;
          if (!content) throw new UsageError('files write needs content: --content "<text>", or --content - to read stdin');
          const res = await api.writeFile(rest[0], content);
          out(`wrote ${res.path} (${res.size} bytes)`);
          return 0;
        }
        if (sub === "rm") {
          if (!rest[0]) throw new UsageError("files rm needs a path");
          await api.deleteFile(rest[0]);
          out(`deleted ${rest[0]}`);
          return 0;
        }
        if (sub === "search") {
          const q = rest.join(" ").trim();
          if (!q) throw new UsageError('files search needs a query: harness files search "budget"');
          const hits = await api.searchFiles(q);
          if (isJson(flags)) { io.stdout(`${JSON.stringify(hits)}\n`); return 0; }
          if (!hits.length) { out(`no matches for "${q}"`); return 0; }
          for (const hit of hits) out(`${hit.path}:${hit.line}  ${hit.text.trim().slice(0, 200)}`);
          return 0;
        }
        throw new UsageError("files needs one of: cat, write, rm, search — see: harness files cat <path>");
      }

      case "plugins": {
        if (flags.enable || flags.disable) {
          const id = (flags.enable ?? flags.disable) as string;
          const plugin = flags.enable ? await api.enablePlugin(id) : await api.disablePlugin(id);
          out(`${plugin.id} is now ${plugin.enabled ? "enabled" : "disabled"}`);
          if (plugin.missingRequired.length) out(`missing config: ${plugin.missingRequired.join(", ")}`);
          return 0;
        }
        const plugins = await api.listPlugins();
        if (isJson(flags)) { io.stdout(`${JSON.stringify(plugins)}\n`); return 0; }
        if (!plugins.length) { out("No plugins installed."); return 0; }
        out(table(
          plugins.map((p) => [p.id, p.version, p.enabled ? "enabled" : "disabled", p.missingRequired.length ? p.missingRequired.join(",") : "ready", p.tools.join(",")]),
          ["id", "version", "state", "config", "tools"],
        ));
        return 0;
      }

      default:
        io.stderr(`unknown command "${command}"\n\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof UsageError) { io.stderr(`${e.message}\n`); return 2; }
    if (e instanceof UnauthorizedError) { io.stderr("access token rejected — set HARNESS_TOKEN to the value the server was started with\n"); return 1; }
    if (e instanceof NetworkError) { io.stderr(`${e.message} — is the server running at ${base}?\n`); return 1; }
    if (e instanceof ApiError) { io.stderr(`${e.code}: ${e.message}\n`); return 1; }
    io.stderr(`${describeError(e)}\n`);
    return 1;
  }
}
