import { ToolRegistry } from "./registry";
import type { WorkspaceLike } from "../fs/types";

/** The filesystem tools, registered against the workspace contract so the server
 *  (Node) and the browser demo (in-memory) expose identical tool behaviour. */
export function registerFsTools(reg: ToolRegistry, ws: WorkspaceLike): void {
  reg.register({ name: "fs.read", description: "Read a workspace file", schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, run: (a) => ws.read(a.path as string) });
  reg.register({ name: "fs.write", description: "Write a workspace file", schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }, run: (a) => { ws.write(a.path as string, a.content as string); return { ok: true }; } });
  reg.register({ name: "fs.list", description: "List a workspace directory", schema: { type: "object", properties: { path: { type: "string" } } }, run: (a) => ws.list((a.path as string) ?? ".") });
  reg.register({ name: "fs.search", description: "Search workspace text", schema: { type: "object", properties: { q: { type: "string", maxLength: 200 } }, required: ["q"] }, run: (a) => ws.search(a.q as string) });
}
