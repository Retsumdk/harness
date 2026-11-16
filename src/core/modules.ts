import { Registry, RegistryError, type ModuleState } from "./registry";

export interface ModuleView {
  id: string;
  version?: string;
  requires: string[];
  state: ModuleState;
  /** Enabled modules that would be stranded by disabling this one. */
  dependants: string[];
  /** Declared dependencies that are not currently running. */
  missing: string[];
}

export class ModuleError extends Error {
  constructor(public code: "unknown" | "duplicate" | "in_use" | "missing_dependency" | "cycle" | "invalid", message: string) {
    super(message);
  }
}

const mapError = (e: unknown): never => {
  if (e instanceof RegistryError) throw new ModuleError(e.code, e.message);
  throw e;
};

/**
 * HTTP-facing view over the module registry: what is registered, what is
 * running, and a runtime enable/disable that refuses to strand dependants.
 */
export class ModuleService {
  constructor(private registry: Registry) {}

  list(): ModuleView[] {
    const mods = this.registry.list();
    return mods.map((m) => {
      const dependants = mods.filter((o) => o.state === "running" && o.requires.includes(m.id)).map((o) => o.id);
      const missing = m.requires.filter((dep) => {
        const found = mods.find((o) => o.id === dep);
        return !found || found.state !== "running";
      });
      return { id: m.id, version: m.version, requires: m.requires, state: m.state, dependants, missing };
    });
  }

  view(id: string): ModuleView {
    const found = this.list().find((m) => m.id === id);
    if (!found) throw new ModuleError("unknown", `unknown module "${id}"`);
    return found;
  }

  /** Starts the module and any dependency that is not running yet. */
  async enable(id: string): Promise<ModuleView> {
    this.view(id); // an unknown id is a 404, never a dependency error
    try {
      await this.registry.enable(id);
    } catch (e) {
      return mapError(e);
    }
    return this.view(id);
  }

  /** Stops a module; refuses while a running module still requires it. */
  async disable(id: string): Promise<ModuleView> {
    try {
      await this.registry.disable(id);
    } catch (e) {
      return mapError(e);
    }
    return this.view(id);
  }
}
