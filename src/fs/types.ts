/** Filesystem contract shared by the Node workspace and the browser demo workspace,
 *  plus the error type both raise. Kept free of Node imports so routes and tools
 *  that only need the contract can be bundled for the browser. */

export class FsError extends Error {
  constructor(public code: "escape" | "not_found" | "too_large" | "invalid", message: string) {
    super(message);
  }
}

export interface WorkspaceEntry { name: string; dir: boolean }
export interface WorkspaceHit { path: string; line: number; text: string }

export interface WorkspaceLike {
  readonly root: string;
  /** Absolute path, or an FsError("escape") when the path leaves the root. */
  resolve(p: string): string;
  read(p: string): string;
  write(p: string, content: string): void;
  info(p?: string): { kind: "file" | "dir"; size: number };
  delete(p: string): void;
  list(p?: string): WorkspaceEntry[];
  search(q: string, limit?: number): WorkspaceHit[];
}
