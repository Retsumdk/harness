import type { Hono } from "hono";
import { ModuleError, type ModuleService } from "../core/modules";
import { PluginError } from "../plugins/types";
import type { PluginService } from "../plugins/service";

const err = (code: string, message: string) => ({ error: { code, message } });

const PLUGIN_STATUS: Record<PluginError["code"], number> = {
  invalid: 400,
  not_found: 404,
  unsupported: 404,
  conflict: 409,
  config_missing: 409,
  failed: 500,
};

const MODULE_STATUS: Record<ModuleError["code"], number> = {
  unknown: 404,
  in_use: 409,
  missing_dependency: 400,
  cycle: 400,
  duplicate: 409,
  invalid: 400,
};

const readBody = async (c: any): Promise<Record<string, unknown> | undefined> => {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body : undefined;
  } catch {
    return undefined;
  }
};

const pluginError = (c: any, e: unknown) => {
  if (e instanceof PluginError) return c.json(err(e.code, e.message), PLUGIN_STATUS[e.code] ?? 400);
  throw e;
};

const moduleError = (c: any, e: unknown) => {
  if (e instanceof ModuleError) return c.json(err(e.code, e.message), MODULE_STATUS[e.code] ?? 400);
  throw e;
};

export function registerPluginRoutes(app: Hono, plugins: PluginService): void {
  app.get("/api/plugins", async (c) => c.json({ plugins: await plugins.list() }));

  app.post("/api/plugins", async (c) => {
    const body = await readBody(c);
    if (!body) return c.json(err("bad_request", "body must be a JSON object"), 400);
    try {
      return c.json({ plugin: await plugins.install(body) }, 201);
    } catch (e) {
      return pluginError(c, e);
    }
  });

  app.get("/api/plugins/:id", async (c) => {
    try {
      return c.json({ plugin: await plugins.get(c.req.param("id")) });
    } catch (e) {
      return pluginError(c, e);
    }
  });

  app.post("/api/plugins/:id/enable", async (c) => {
    try {
      return c.json({ plugin: await plugins.enable(c.req.param("id")) });
    } catch (e) {
      return pluginError(c, e);
    }
  });

  app.post("/api/plugins/:id/disable", async (c) => {
    try {
      return c.json({ plugin: await plugins.disable(c.req.param("id")) });
    } catch (e) {
      return pluginError(c, e);
    }
  });

  app.put("/api/plugins/:id/config", async (c) => {
    const body = await readBody(c);
    if (!body) return c.json(err("bad_request", "body must be a JSON object"), 400);
    try {
      return c.json({ plugin: await plugins.configure(c.req.param("id"), body) });
    } catch (e) {
      return pluginError(c, e);
    }
  });

  app.delete("/api/plugins/:id", async (c) => {
    try {
      const removed = await plugins.uninstall(c.req.param("id"));
      if (!removed) return c.json(err("not_found", "plugin not installed"), 404);
      return c.json({ ok: true });
    } catch (e) {
      return pluginError(c, e);
    }
  });
}

export function registerModuleRoutes(app: Hono, modules: ModuleService): void {
  app.get("/api/modules", (c) => c.json({ modules: modules.list() }));

  app.post("/api/modules/:id/enable", async (c) => {
    try {
      return c.json({ module: await modules.enable(c.req.param("id")) });
    } catch (e) {
      return moduleError(c, e);
    }
  });

  app.post("/api/modules/:id/disable", async (c) => {
    try {
      return c.json({ module: await modules.disable(c.req.param("id")) });
    } catch (e) {
      return moduleError(c, e);
    }
  });
}
