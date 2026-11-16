import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSandboxed, ShellDenied } from "../src/tools/shell";
import { ToolRegistry } from "../src/tools/registry";
import { registerBuiltins } from "../src/tools/builtins";
import { Workspace } from "../src/fs/workspace";

const cwd = mkdtempSync(join(tmpdir(), "sh-"));
test("allowlisted command runs", async () => { const r = await runSandboxed("echo", ["hi"], { cwd, allow: ["echo"] }); expect(r.stdout).toBe("hi\n"); expect(r.code).toBe(0); });
test("non-allowlisted denied", () => expect(runSandboxed("rm", ["-rf", "/"], { cwd, allow: ["echo"] })).rejects.toBeInstanceOf(ShellDenied));
test("no shell injection", async () => { const r = await runSandboxed("echo", ["a; echo b"], { cwd, allow: ["echo"] }); expect(r.stdout).toBe("a; echo b\n"); });
test("timeout kills", async () => { const r = await runSandboxed("sleep", ["5"], { cwd, allow: ["sleep"], timeoutMs: 100 }); expect(r.timedOut).toBe(true); });
test("output capped", async () => { const r = await runSandboxed("echo", ["x".repeat(500)], { cwd, allow: ["echo"], maxOutput: 50 }); expect(r.truncated).toBe(true); expect(r.stdout.length).toBe(50); });
test("env is scrubbed", async () => { process.env.SECRET_TEST = "s"; const r = await runSandboxed("env", [], { cwd, allow: ["env"] }); expect(r.stdout).not.toContain("SECRET_TEST"); });
test("spawn failure reported", async () => { const r = await runSandboxed("definitely-not-a-cmd", [], { cwd, allow: ["definitely-not-a-cmd"] }); expect(r.code).toBeNull(); });test("an argument cannot climb out of the workspace", async () => {
  await expect(runSandboxed("cat", ["../../etc/passwd"], { cwd, allow: ["cat"] })).rejects.toBeInstanceOf(ShellDenied);
  await expect(runSandboxed("cat", ["notes/../../secret"], { cwd, allow: ["cat"] })).rejects.toBeInstanceOf(ShellDenied);
});
test("an absolute argument is refused", async () => {
  await expect(runSandboxed("cat", ["/etc/passwd"], { cwd, allow: ["cat"] })).rejects.toBeInstanceOf(ShellDenied);
  await expect(runSandboxed("ls", ["~/"], { cwd, allow: ["ls"] })).rejects.toBeInstanceOf(ShellDenied);
});
test("ordinary relative arguments still run", async () => { const r = await runSandboxed("echo", ["notes/x.txt", "-n"], { cwd, allow: ["echo"] }); expect(r.stdout).toBe("notes/x.txt -n\n"); });
test("builtins end to end through registry", async () => {
  const reg = new ToolRegistry(); const ws = new Workspace(join(cwd, "w")); registerBuiltins(reg, ws);
  await reg.call("fs.write", { path: "f.txt", content: "needle" });
  expect(await reg.call("fs.read", { path: "f.txt" })).toBe("needle");
  expect(await reg.call("fs.list", {})).toHaveLength(1);
  expect(await reg.call("fs.search", { q: "needle" })).toHaveLength(1);
  expect(((await reg.call("shell.run", { command: "ls" })) as any).stdout).toContain("f.txt");
  await expect(reg.call("shell.run", { command: "rm" })).rejects.toMatchObject({ code: "failed" });
  await expect(reg.call("fs.read", { path: "../x" })).rejects.toMatchObject({ code: "failed" });
});
