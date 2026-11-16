import { mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync, realpathSync, existsSync } from "node:fs";
import { resolve, sep, dirname, relative, join } from "node:path";
import { FsError } from "./types";
import type { WorkspaceLike } from "./types";

// Re-exported so every existing `import { FsError } from "../fs/workspace"` keeps working.
export { FsError };

export class Workspace implements WorkspaceLike {
  readonly root: string;
  constructor(root: string, private maxBytes = 1_000_000) {
    mkdirSync(root, { recursive: true });
    this.root = realpathSync(root);
  }

  resolve(p: string): string {
    if (typeof p !== "string" || p.includes("\0")) throw new FsError("escape", "invalid path");
    const abs = resolve(this.root, p.replace(/^[/\\]+/, ""));
    if (abs !== this.root && !abs.startsWith(this.root + sep)) throw new FsError("escape", `path escapes workspace: ${p}`);
    let probe = abs;
    while (!existsSync(probe) && probe !== this.root) probe = dirname(probe);
    const real = realpathSync(probe);
    if (real !== this.root && !real.startsWith(this.root + sep)) throw new FsError("escape", `symlink escapes workspace: ${p}`);
    return abs;
  }

  read(p: string): string {
    const abs = this.resolve(p);
    if (!existsSync(abs)) throw new FsError("not_found", `no such file: ${p}`);
    if (statSync(abs).size > this.maxBytes) throw new FsError("too_large", `file exceeds ${this.maxBytes} bytes`);
    return readFileSync(abs, "utf8");
  }

  write(p: string, content: string): void {
    if (Buffer.byteLength(content) > this.maxBytes) throw new FsError("too_large", `content exceeds ${this.maxBytes} bytes`);
    const abs = this.resolve(p);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  /** Kind and size of a path, used by the file browser to pick a panel. */
  info(p = "."): { kind: "file" | "dir"; size: number } {
    const abs = this.resolve(p);
    if (!existsSync(abs)) throw new FsError("not_found", `no such path: ${p}`);
    const st = statSync(abs);
    return { kind: st.isDirectory() ? "dir" : "file", size: st.size };
  }

  delete(p: string): void {
    const abs = this.resolve(p);
    if (abs === this.root) throw new FsError("escape", "cannot delete workspace root");
    if (!existsSync(abs)) throw new FsError("not_found", `no such file: ${p}`);
    rmSync(abs, { recursive: true });
  }

  list(p = "."): { name: string; dir: boolean }[] {
    const abs = this.resolve(p);
    if (!existsSync(abs)) throw new FsError("not_found", `no such directory: ${p}`);
    return readdirSync(abs, { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() })).sort((a, b) => a.name.localeCompare(b.name));
  }

  search(q: string, limit = 50): { path: string; line: number; text: string }[] {
    const out: { path: string; line: number; text: string }[] = [];
    const walk = (dir: string) => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        if (out.length >= limit) return;
        const full = join(dir, d.name);
        if (d.isDirectory()) walk(full);
        else if (d.isFile() && statSync(full).size <= this.maxBytes) {
          readFileSync(full, "utf8").split("\n").forEach((text, i) => {
            if (out.length < limit && text.includes(q)) out.push({ path: relative(this.root, full), line: i + 1, text: text.slice(0, 200) });
          });
        }
      }
    };
    walk(this.root);
    return out;
  }
}
