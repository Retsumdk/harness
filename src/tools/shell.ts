import { spawn } from "node:child_process";

export interface ShellOptions {
  cwd: string;
  allow: string[];
  timeoutMs?: number;
  maxOutput?: number;
}

export interface ShellResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

export class ShellDenied extends Error {}

const ESCAPE = /(^|[\\/])\.\.([\\/]|$)/;

/**
 * The allowlist says which commands may run; this says what they may point at.
 * The child runs with the workspace as its cwd, so an absolute argument or a
 * `..` segment is the only way out of it — refuse both before spawning.
 */
export function assertConfinedArgs(args: string[]): void {
  for (const arg of args) {
    if (arg.startsWith("/") || arg.startsWith("~")) throw new ShellDenied(`absolute path not allowed: ${arg}`);
    if (ESCAPE.test(arg)) throw new ShellDenied(`path escapes the workspace: ${arg}`);
  }
}

export function runSandboxed(command: string, args: string[], o: ShellOptions): Promise<ShellResult> {
  if (!o.allow.includes(command)) return Promise.reject(new ShellDenied(`command not allowed: ${command}`));
  try { assertConfinedArgs(args); } catch (e) { return Promise.reject(e); }
  const timeoutMs = o.timeoutMs ?? 5000;
  const max = o.maxOutput ?? 64_000;
  return new Promise((res) => {
    const child = spawn(command, args, { cwd: o.cwd, shell: false, env: { PATH: process.env.PATH ?? "" } });
    let stdout = "", stderr = "", timedOut = false, truncated = false;
    const take = (cur: string, chunk: Buffer) => {
      const next = cur + chunk.toString();
      if (next.length > max) { truncated = true; return next.slice(0, max); }
      return next;
    };
    child.stdout.on("data", (c) => (stdout = take(stdout, c)));
    child.stderr.on("data", (c) => (stderr = take(stderr, c)));
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); res({ code: null, stdout, stderr: stderr + e.message, timedOut, truncated }); });
    child.on("close", (code) => { clearTimeout(timer); res({ code, stdout, stderr, timedOut, truncated }); });
  });
}
