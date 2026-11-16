import type { Hono } from "hono";
import { FsError, type WorkspaceLike } from "../fs/types";
import type { Store } from "../store/types";
import type { ChatService } from "../chat/service";

export const SETTING_PROVIDER = "provider.default";
export const SETTING_MODEL = "model.default";

export interface WorkspaceRouteDeps {
  store: Store;
  workspace: WorkspaceLike;
  chat: ChatService;
  version?: string;
  /** Names of the tools the runtime currently exposes; shown on the settings page. */
  tools?: () => string[];
  /** Module registry snapshot, so Settings can show what is running. */
  modules?: () => { id: string; state: string }[];
}

export interface SettingsView {
  provider: string;
  model: string;
}

const err = (code: string, message: string) => ({ error: { code, message } });

const FS_STATUS: Record<FsError["code"], number> = { escape: 400, not_found: 404, too_large: 413, invalid: 400 };

/** UTF-8 byte length without reaching for `Buffer`: these routes also run in a
 *  browser tab (the static demo), where `Buffer` is not defined. */
const byteLength = (s: string): number => new TextEncoder().encode(s).length;

const fsFail = (c: any, e: unknown) => {
  if (e instanceof FsError) {
    const code = e.code === "not_found" ? "not_found" : e.code === "too_large" ? "too_large" : "bad_request";
    return c.json(err(code, e.message), FS_STATUS[e.code]);
  }
  throw e;
};

/** Paths are joined with forward slashes so the browser can send them back verbatim. */
const childPath = (dir: string, name: string) =>
  dir === "." || dir === "" || dir === "/" ? name : `${dir.replace(/\/+$/, "")}/${name}`;

export async function readSettings(store: Store): Promise<SettingsView> {
  return {
    provider: (await store.getSetting(SETTING_PROVIDER)) ?? "",
    model: (await store.getSetting(SETTING_MODEL)) ?? "",
  };
}

export function registerWorkspaceRoutes(app: Hono, deps: WorkspaceRouteDeps): void {
  const { store, workspace, chat } = deps;

  app.get("/api/files", async (c) => {
    const path = c.req.query("path") || ".";
    try {
      const info = workspace.info(path);
      if (info.kind === "file") {
        return c.json({ type: "file", path, content: workspace.read(path), size: info.size });
      }
      const entries = workspace.list(path).map((entry) => {
        const full = childPath(path, entry.name);
        let size: number | undefined;
        if (!entry.dir) {
          try { size = workspace.info(full).size; } catch { size = undefined; }
        }
        return { name: entry.name, kind: entry.dir ? "dir" : "file", path: full, size };
      });
      return c.json({ type: "dir", path, entries });
    } catch (e) {
      return fsFail(c, e);
    }
  });

  app.get("/api/files/search", async (c) => {
    const q = c.req.query("q") ?? "";
    if (!q.trim()) return c.json(err("bad_request", "\"q\" must be a non-empty search string"), 400);
    if (q.length > 200) return c.json(err("bad_request", "\"q\" must be 200 characters or fewer"), 400);
    try {
      return c.json({ results: workspace.search(q) });
    } catch (e) {
      return fsFail(c, e);
    }
  });

  app.put("/api/files", async (c) => {
    const path = c.req.query("path");
    if (!path) return c.json(err("bad_request", "\"path\" query parameter is required"), 400);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json(err("bad_request", "body must be JSON"), 400); }
    const content = (body as { content?: unknown } | null)?.content;
    if (typeof content !== "string") return c.json(err("bad_request", "\"content\" must be a string"), 400);
    try {
      if (workspace.info(path).kind === "dir") return c.json(err("bad_request", `"${path}" is a directory`), 400);
    } catch {
      // A missing file is a create, which is the normal case for a new note.
    }
    try {
      workspace.write(path, content);
      return c.json({ ok: true, path, size: byteLength(content) });
    } catch (e) {
      return fsFail(c, e);
    }
  });

  app.delete("/api/files", async (c) => {
    const path = c.req.query("path");
    if (!path) return c.json(err("bad_request", "\"path\" query parameter is required"), 400);
    try {
      workspace.delete(path);
      return c.json({ ok: true, path });
    } catch (e) {
      return fsFail(c, e);
    }
  });

  app.get("/api/settings", async (c) => c.json({
    settings: await readSettings(store),
    providers: chat.providerIds(),
    defaultProvider: chat.defaultProviderId(),
    tools: deps.tools?.() ?? [],
    modules: deps.modules?.() ?? [],
    workspace: workspace.root,
    version: deps.version ?? "0.1.0",
  }));

  app.put("/api/settings", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json(err("bad_request", "body must be JSON"), 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json(err("bad_request", "body must be a JSON object"), 400);
    const { provider, model } = body as { provider?: unknown; model?: unknown };
    if (provider !== undefined) {
      if (typeof provider !== "string") return c.json(err("bad_request", "\"provider\" must be a string"), 400);
      if (provider && !chat.providerIds().includes(provider))
        return c.json(err("bad_request", `unknown provider "${provider}" (known: ${chat.providerIds().join(", ")})`), 400);
      await store.setSetting(SETTING_PROVIDER, provider);
    }
    if (model !== undefined) {
      if (typeof model !== "string") return c.json(err("bad_request", "\"model\" must be a string"), 400);
      if (model.length > 120) return c.json(err("bad_request", "\"model\" must be 120 characters or fewer"), 400);
      await store.setSetting(SETTING_MODEL, model);
    }
    return c.json({ settings: await readSettings(store) });
  });
}
