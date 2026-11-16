/**
 * The workspace contract, implemented over a Map, so the same routes, tools and
 * agent runner can run inside a browser tab. The rules that matter are kept:
 * escaping the root is an FsError("escape"), a missing path is FsError("not_found"),
 * and a write above the size cap is FsError("too_large").
 */
import { FsError, type WorkspaceEntry, type WorkspaceHit, type WorkspaceLike } from "../fs/types";

const MAX_BYTES = 1_000_000;

/** Normalises to a root-relative path with no leading slash; "." means the root. */
export function normalizePath(p: string): string {
  if (typeof p !== "string" || p.includes("\0")) throw new FsError("escape", "invalid path");
  const parts: string[] = [];
  for (const raw of p.replace(/\\/g, "/").split("/")) {
    if (!raw || raw === ".") continue;
    if (raw === "..") {
      if (!parts.length) throw new FsError("escape", `path escapes workspace: ${p}`);
      parts.pop();
      continue;
    }
    parts.push(raw);
  }
  return parts.join("/") || ".";
}

const byteLength = (s: string): number => {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s).length;
  return s.length;
};

export class MemoryWorkspace implements WorkspaceLike {
  readonly root = "/workspace";
  private files = new Map<string, string>();

  /** Every path currently stored, sorted. Used by the demo seed and by tests. */
  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  resolve(p: string): string {
    const clean = normalizePath(p);
    return clean === "." ? this.root : `${this.root}/${clean}`;
  }

  read(p: string): string {
    const key = normalizePath(p);
    const content = this.files.get(key);
    if (content === undefined) throw new FsError("not_found", `no such file: ${p}`);
    return content;
  }

  write(p: string, content: string): void {
    const key = normalizePath(p);
    if (key === ".") throw new FsError("escape", "cannot write the workspace root");
    if (byteLength(content) > MAX_BYTES) throw new FsError("too_large", `content exceeds ${MAX_BYTES} bytes`);
    this.files.set(key, content);
  }

  info(p = "."): { kind: "file" | "dir"; size: number } {
    const key = normalizePath(p);
    if (key === ".") return { kind: "dir", size: 0 };
    const content = this.files.get(key);
    if (content !== undefined) return { kind: "file", size: byteLength(content) };
    if (this.hasChildren(key)) return { kind: "dir", size: 0 };
    throw new FsError("not_found", `no such path: ${p}`);
  }

  delete(p: string): void {
    const key = normalizePath(p);
    if (key === ".") throw new FsError("escape", "cannot delete workspace root");
    if (this.files.delete(key)) return;
    if (!this.hasChildren(key)) throw new FsError("not_found", `no such file: ${p}`);
    for (const path of [...this.files.keys()]) {
      if (path.startsWith(`${key}/`)) this.files.delete(path);
    }
  }

  list(p = "."): WorkspaceEntry[] {
    const key = normalizePath(p);
    if (key !== "." && this.files.has(key)) throw new FsError("not_found", `no such directory: ${p}`);
    const prefix = key === "." ? "" : `${key}/`;
    if (key !== "." && !this.hasChildren(key)) throw new FsError("not_found", `no such directory: ${p}`);
    const entries = new Map<string, boolean>();
    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (!rest) continue;
      const cut = rest.indexOf("/");
      if (cut === -1) entries.set(rest, false);
      else entries.set(rest.slice(0, cut), true);
    }
    return [...entries.entries()]
      .map(([name, dir]) => ({ name, dir }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  search(q: string, limit = 50): WorkspaceHit[] {
    const hits: WorkspaceHit[] = [];
    for (const [path, content] of this.files) {
      content.split("\n").forEach((text, i) => {
        if (hits.length < limit && text.includes(q)) hits.push({ path, line: i + 1, text: text.slice(0, 200) });
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  private hasChildren(key: string): boolean {
    const prefix = `${key}/`;
    for (const path of this.files.keys()) if (path.startsWith(prefix)) return true;
    return false;
  }
}
