import type { Store } from "../store/types";
import type { ToolRegistry } from "../tools/registry";
import { ToolError } from "../tools/registry";
import type { EventBus } from "../core/events";
import {
  PluginError, validateManifest, validateConfig, missingRequired, toView,
  type PluginConfig, type PluginManifest, type PluginRecord, type PluginView,
} from "./types";
import { githubPlugin } from "./builtins/github";
import { webhookPlugin } from "./builtins/webhook";

/** A plugin's actual behaviour. Manifests declare; implementations execute. */
export interface PluginImplementation {
  manifest: PluginManifest;
  /** Handlers keyed by the fully qualified tool name from the manifest. */
  handlers: Record<string, (args: Record<string, unknown>, ctx: PluginRuntime) => Promise<unknown> | unknown>;
}

/** Minimal fetch shape so tests can inject a fake without the DOM/Node overloads. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface PluginRuntime {
  config: PluginConfig;
  fetch: FetchLike;
}

export interface PluginServiceDeps {
  store: Store;
  tools: ToolRegistry;
  bus?: EventBus;
  fetchImpl?: FetchLike;
  now?: () => number;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export class PluginService {
  private impls = new Map<string, PluginImplementation>();
  private registered = new Map<string, string[]>();
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(private deps: PluginServiceDeps) {
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input as RequestInfo, init));
    this.now = deps.now ?? (() => Date.now());
    // Built-ins ship with the app; third parties add the same shape at runtime.
    this.registerImplementation(githubPlugin());
    this.registerImplementation(webhookPlugin());
  }

  registerImplementation(impl: PluginImplementation): void {
    const manifest = validateManifest(impl.manifest);
    for (const tool of manifest.tools) {
      if (!impl.handlers[tool.name]) throw new PluginError("invalid", `implementation for "${manifest.id}" is missing a handler for "${tool.name}"`);
    }
    this.impls.set(manifest.id, { manifest, handlers: { ...impl.handlers } });
  }

  builtinIds(): string[] {
    return [...this.impls.keys()];
  }

  /** Installs every built-in that is not in the store yet, disabled. Idempotent. */
  async seedBuiltins(): Promise<PluginView[]> {
    const existing = new Set((await this.deps.store.listPlugins()).map((p) => p.id));
    for (const [id, impl] of this.impls) {
      if (existing.has(id)) continue;
      await this.install(impl.manifest);
    }
    return this.list();
  }

  async install(input: unknown): Promise<PluginView> {
    const manifest = validateManifest(input);
    const impl = this.impls.get(manifest.id);
    if (!impl) throw new PluginError("unsupported", `no implementation is registered for plugin "${manifest.id}"`);
    for (const tool of manifest.tools) {
      if (this.deps.tools.has(tool.name)) throw new PluginError("conflict", `tool "${tool.name}" is already registered`);
    }
    const existing = await this.deps.store.getPlugin(manifest.id);
    const at = this.now();
    const rec: PluginRecord = {
      id: manifest.id,
      enabled: existing?.enabled ?? false,
      manifest,
      config: existing?.config ?? {},
      installedAt: existing?.installedAt ?? at,
      updatedAt: at,
    };
    await this.deps.store.upsertPlugin(rec);
    if (rec.enabled) this.attach(rec.id, manifest, rec.config);
    return this.view(rec);
  }

  async list(): Promise<PluginView[]> {
    const recs = await this.deps.store.listPlugins();
    const seen = new Set(recs.map((r) => r.id));
    const views = recs.map((r) => this.view(r));
    for (const [id, impl] of this.impls) {
      if (!seen.has(id)) views.push(this.view(this.emptyRecord(id, impl.manifest)));
    }
    return views.sort((a, b) => a.id.localeCompare(b.id));
  }

  async get(id: string): Promise<PluginView> {
    const rec = await this.requireRecord(id, false);
    return this.view(rec);
  }

  async enable(id: string): Promise<PluginView> {
    const rec = await this.requireRecord(id, true);
    const impl = this.impls.get(id);
    if (!impl) throw new PluginError("unsupported", `no implementation is registered for plugin "${id}"`);
    const missing = missingRequired(rec.manifest, rec.config);
    if (missing.length) throw new PluginError("config_missing", `configure required field(s) first: ${missing.join(", ")}`);
    if (!rec.enabled) {
      for (const tool of rec.manifest.tools) {
        if (this.deps.tools.has(tool.name)) throw new PluginError("conflict", `tool "${tool.name}" is already registered`);
      }
      this.attach(id, rec.manifest, rec.config);
      const next = { ...rec, enabled: true, updatedAt: this.now() };
      await this.deps.store.upsertPlugin(next);
      await this.deps.bus?.emit("plugin:enabled", { id });
      return this.view(next);
    }
    return this.view(rec);
  }

  async disable(id: string): Promise<PluginView> {
    const rec = await this.requireRecord(id);
    this.detach(id);
    const next = { ...rec, enabled: false, updatedAt: this.now() };
    await this.deps.store.upsertPlugin(next);
    await this.deps.bus?.emit("plugin:disabled", { id });
    return this.view(next);
  }

  /**
   * Merge `values` into the stored config. Unknown keys, wrong types and
   * missing required fields (while enabled) are rejected server-side.
   */
  async configure(id: string, values: unknown): Promise<PluginView> {
    const rec = await this.requireRecord(id, true);
    if (!isPlainObject(values)) throw new PluginError("invalid", "config must be a JSON object");
    const merged = { ...rec.config } as Record<string, unknown>;
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue;
      merged[key] = value === null ? undefined : value;
      if (merged[key] === undefined) delete merged[key];
    }
    const config = validateConfig(rec.manifest, merged, rec.enabled);
    const next = { ...rec, config, updatedAt: this.now() };
    await this.deps.store.upsertPlugin(next);
    if (next.enabled) {
      this.detach(id);
      this.attach(id, next.manifest, next.config);
      await this.deps.bus?.emit("plugin:configured", { id });
    }
    return this.view(next);
  }

  /** Removes a disabled plugin from the store. Enabled plugins must be disabled first. */
  async uninstall(id: string): Promise<boolean> {
    const rec = await this.requireRecord(id);
    if (rec.enabled) throw new PluginError("conflict", `plugin "${id}" is enabled; disable it first`);
    this.detach(id);
    return this.deps.store.deletePlugin(id);
  }

  /** Tool names currently provided by running plugins — used for run allowlists. */
  activeTools(): string[] {
    return [...this.registered.values()].flat();
  }

  // ---- internals ---------------------------------------------------------

  private attach(id: string, manifest: PluginManifest, config: PluginConfig): void {
    const impl = this.impls.get(id);
    if (!impl) throw new PluginError("unsupported", `no implementation is registered for plugin "${id}"`);
    const names: string[] = [];
    for (const tool of manifest.tools) {
      this.deps.tools.register({
        name: tool.name,
        description: tool.description,
        schema: tool.schema,
        run: (args) => {
          const handler = impl.handlers[tool.name];
          if (!handler) throw new ToolError("failed", `plugin "${id}" has no handler for "${tool.name}"`);
          return handler(args, { config, fetch: this.fetchImpl });
        },
      });
      names.push(tool.name);
    }
    this.registered.set(id, names);
  }

  private detach(id: string): void {
    for (const name of this.registered.get(id) ?? []) this.deps.tools.unregister(name);
    this.registered.delete(id);
  }

  /**
   * Loads a plugin's stored state. A registered built-in that has never been
   * written to the store is materialised as installed-but-disabled, so the list
   * a client sees and the objects it can act on are the same set.
   */
  private async requireRecord(id: string, materialise = false): Promise<PluginRecord> {
    if (typeof id !== "string" || !id) throw new PluginError("not_found", "plugin id is required");
    const rec = await this.deps.store.getPlugin(id);
    if (rec) return rec;
    if (!materialise) throw new PluginError("not_found", `plugin "${id}" is not installed`);
    const impl = this.impls.get(id);
    if (!impl) throw new PluginError("not_found", `plugin "${id}" is not installed`);
    const materialised = this.emptyRecord(id, impl.manifest);
    await this.deps.store.upsertPlugin(materialised);
    return materialised;
  }

  private emptyRecord(id: string, manifest: PluginManifest): PluginRecord {
    return { id, enabled: false, manifest, config: {}, installedAt: 0, updatedAt: 0 };
  }

  private view(rec: PluginRecord): PluginView {
    return toView(rec, this.deps.tools.list().map((t) => t.name));
  }
}
