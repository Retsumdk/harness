import { EventBus } from "./events";

export interface Module {
  id: string;
  version?: string;
  requires?: string[];
  start?(ctx: ModuleContext): void | Promise<void>;
  stop?(): void | Promise<void>;
}

export interface ModuleContext {
  bus: EventBus;
  registry: Registry;
}

export type ModuleState = "registered" | "running" | "stopped";

export class RegistryError extends Error {
  constructor(public code: "duplicate" | "unknown" | "missing_dependency" | "cycle" | "in_use", message: string) {
    super(message);
  }
}

export class Registry {
  readonly bus = new EventBus();
  private mods = new Map<string, Module>();
  private state = new Map<string, ModuleState>();

  register(mod: Module): void {
    if (this.mods.has(mod.id)) throw new RegistryError("duplicate", `module "${mod.id}" already registered`);
    this.mods.set(mod.id, mod);
    this.state.set(mod.id, "registered");
  }

  list(): { id: string; version?: string; requires: string[]; state: ModuleState }[] {
    return [...this.mods.values()].map((m) => ({
      id: m.id, version: m.version, requires: m.requires ?? [], state: this.state.get(m.id)!,
    }));
  }

  get<T extends Module = Module>(id: string): T {
    const m = this.mods.get(id);
    if (!m) throw new RegistryError("unknown", `unknown module "${id}"`);
    return m as T;
  }

  stateOf(id: string): ModuleState {
    this.get(id);
    return this.state.get(id)!;
  }

  /** Dependency-first start order for the given ids (and everything they require). */
  order(ids: string[]): string[] {
    const out: string[] = [];
    const mark = new Map<string, 1 | 2>();
    const visit = (id: string, path: string[]) => {
      const m = this.mods.get(id);
      if (!m) throw new RegistryError("missing_dependency", `"${path[path.length - 1] ?? id}" requires missing module "${id}"`);
      if (mark.get(id) === 2) return;
      if (mark.get(id) === 1) throw new RegistryError("cycle", `dependency cycle: ${[...path, id].join(" -> ")}`);
      mark.set(id, 1);
      for (const dep of m.requires ?? []) visit(dep, [...path, id]);
      mark.set(id, 2);
      out.push(id);
    };
    for (const id of ids) visit(id, []);
    return out;
  }

  async start(ids: string[] = [...this.mods.keys()]): Promise<string[]> {
    const started: string[] = [];
    for (const id of this.order(ids)) {
      if (this.state.get(id) === "running") continue;
      await this.mods.get(id)!.start?.({ bus: this.bus, registry: this });
      this.state.set(id, "running");
      started.push(id);
      await this.bus.emit("module:started", { id });
    }
    return started;
  }

  async enable(id: string): Promise<string[]> {
    return this.start([id]);
  }

  async disable(id: string): Promise<void> {
    this.get(id);
    if (this.state.get(id) !== "running") return;
    const dependants = [...this.mods.values()].filter(
      (m) => this.state.get(m.id) === "running" && (m.requires ?? []).includes(id),
    );
    if (dependants.length)
      throw new RegistryError("in_use", `"${id}" is required by running module(s): ${dependants.map((d) => d.id).join(", ")}`);
    await this.mods.get(id)!.stop?.();
    this.state.set(id, "stopped");
    await this.bus.emit("module:stopped", { id });
  }

  async stopAll(): Promise<void> {
    const running = [...this.mods.keys()].filter((id) => this.state.get(id) === "running");
    for (const id of this.order(running).reverse()) {
      await this.mods.get(id)!.stop?.();
      this.state.set(id, "stopped");
      await this.bus.emit("module:stopped", { id });
    }
  }
}
