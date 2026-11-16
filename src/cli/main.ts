#!/usr/bin/env bun
/** Entry point: wires real stdio and env into the testable CLI. */
import { runCli } from "./run";

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
    readStdin: async () => await Bun.stdin.text(),
  });
  process.exit(code);
}

export { runCli } from "./run";
