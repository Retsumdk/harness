import { ToolRegistry } from "./registry";
import { registerFsTools } from "./fs-tools";
import type { WorkspaceLike } from "../fs/types";
import { runSandboxed } from "./shell";

export function registerBuiltins(reg: ToolRegistry, ws: WorkspaceLike, shellAllow: string[] = ["echo", "ls", "cat", "pwd", "wc"]): void {
  registerFsTools(reg, ws);
  reg.register({ name: "shell.run", description: "Run an allowlisted command in the workspace", schema: { type: "object", properties: { command: { type: "string" }, args: { type: "array" } }, required: ["command"] }, run: (a) => runSandboxed(a.command as string, ((a.args as unknown[]) ?? []).map(String), { cwd: ws.root, allow: shellAllow }) });
}
