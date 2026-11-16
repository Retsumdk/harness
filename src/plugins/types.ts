import type { JsonSchema } from "../tools/registry";

export type Permission = "network" | "filesystem" | "secrets";
export const PERMISSIONS: Permission[] = ["network", "filesystem", "secrets"];

export type ConfigType = "string" | "number" | "boolean";

export interface ConfigField {
  name: string;
  type: ConfigType;
  required?: boolean;
  secret?: boolean;
  description?: string;
}

export interface PluginToolSpec {
  name: string;
  description: string;
  schema: JsonSchema;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  permissions: Permission[];
  config: ConfigField[];
  tools: PluginToolSpec[];
}

export class PluginError extends Error {
  constructor(
    public code: "invalid" | "not_found" | "conflict" | "config_missing" | "failed" | "unsupported",
    message: string,
  ) {
    super(message);
  }
}

const ID_RE = /^[a-z][a-z0-9-]{1,38}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const TOOL_RE = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9_]*$/;
const MANIFEST_KEYS = new Set(["id", "name", "version", "description", "permissions", "config", "tools"]);
const TOOL_KEYS = new Set(["name", "description", "schema"]);
const FIELD_KEYS = new Set(["name", "type", "required", "secret", "description"]);
const MAX_TOOLS = 20;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Validates an untrusted plugin manifest. Throws PluginError("invalid") listing every
 * problem at once, so a plugin author can fix the manifest in one pass.
 */
export function validateManifest(input: unknown): PluginManifest {
  const errs: string[] = [];
  if (!isObject(input)) throw new PluginError("invalid", "manifest must be an object");

  for (const key of Object.keys(input)) {
    if (!MANIFEST_KEYS.has(key)) errs.push(`unexpected field "${key}"`);
  }

  const id = input.id;
  if (typeof id !== "string") errs.push(`"id" must be a string`);
  else if (!ID_RE.test(id)) errs.push(`"id" must be 2-39 chars, lowercase letters, digits or dashes, starting with a letter`);

  const name = input.name;
  if (typeof name !== "string" || !name.trim()) errs.push(`"name" must be a non-empty string`);
  else if (name.length > 64) errs.push(`"name" must be 64 characters or fewer`);

  const version = input.version;
  if (typeof version !== "string" || !VERSION_RE.test(version)) errs.push(`"version" must be semver, e.g. "1.0.0"`);

  const description = input.description ?? "";
  if (typeof description !== "string") errs.push(`"description" must be a string`);
  else if (description.length > 500) errs.push(`"description" must be 500 characters or fewer`);

  const permissions: Permission[] = [];
  if (input.permissions !== undefined) {
    if (!Array.isArray(input.permissions)) errs.push(`"permissions" must be an array`);
    else {
      for (const p of input.permissions) {
        if (typeof p !== "string" || !PERMISSIONS.includes(p as Permission)) errs.push(`unknown permission "${String(p)}" (allowed: ${PERMISSIONS.join(", ")})`);
        else if (!permissions.includes(p as Permission)) permissions.push(p as Permission);
      }
    }
  }

  const config: ConfigField[] = [];
  if (input.config !== undefined) {
    if (!Array.isArray(input.config)) errs.push(`"config" must be an array`);
    else {
      const seen = new Set<string>();
      for (const [i, raw] of input.config.entries()) {
        if (!isObject(raw)) { errs.push(`config[${i}] must be an object`); continue; }
        for (const key of Object.keys(raw)) if (!FIELD_KEYS.has(key)) errs.push(`config[${i}] has unexpected field "${key}"`);
        const fname = raw.name;
        if (typeof fname !== "string" || !FIELD_RE.test(fname)) errs.push(`config[${i}].name must be a valid identifier`);
        else if (seen.has(fname)) errs.push(`duplicate config field "${fname}"`);
        else seen.add(fname);
        if (raw.type !== "string" && raw.type !== "number" && raw.type !== "boolean")
          errs.push(`config[${i}].type must be string, number or boolean`);
        for (const k of ["required", "secret"] as const) {
          if (raw[k] !== undefined && typeof raw[k] !== "boolean") errs.push(`config[${i}].${k} must be a boolean`);
        }
        if (raw.description !== undefined) {
          if (typeof raw.description !== "string") errs.push(`config[${i}].description must be a string`);
          else if (raw.description.length > 200) errs.push(`config[${i}].description must be 200 characters or fewer`);
        }
        if (typeof fname === "string" && FIELD_RE.test(fname)) {
          config.push({
            name: fname,
            type: raw.type as ConfigType,
            required: (raw.required as boolean) ?? false,
            secret: (raw.secret as boolean) ?? false,
            description: raw.description as string | undefined,
          });
        }
      }
    }
  }

  const tools: PluginToolSpec[] = [];
  if (input.tools === undefined) errs.push(`"tools" must be an array with at least one tool`);
  else if (!Array.isArray(input.tools)) errs.push(`"tools" must be an array`);
  else if (input.tools.length === 0) errs.push(`"tools" must declare at least one tool`);
  else if (input.tools.length > MAX_TOOLS) errs.push(`"tools" may declare at most ${MAX_TOOLS} tools`);
  else {
    const seen = new Set<string>();
    for (const [i, raw] of input.tools.entries()) {
      if (!isObject(raw)) { errs.push(`tools[${i}] must be an object`); continue; }
      for (const key of Object.keys(raw)) if (!TOOL_KEYS.has(key)) errs.push(`tools[${i}] has unexpected field "${key}"`);
      const tname = raw.name;
      if (typeof tname !== "string" || !TOOL_RE.test(tname)) errs.push(`tools[${i}].name must look like "<plugin-id>.<tool_name>"`);
      else if (seen.has(tname)) errs.push(`duplicate tool "${tname}"`);
      else seen.add(tname);
      if (typeof raw.description !== "string" || !raw.description.trim())
        errs.push(`tools[${i}].description must be a non-empty string`);
      if (!isObject(raw.schema) || raw.schema.type !== "object")
        errs.push(`tools[${i}].schema must be an object schema with type "object"`);
      if (typeof tname === "string" && typeof id === "string" && !tname.startsWith(`${id}.`))
        errs.push(`tools[${i}].name must be namespaced under "${id}."`);
      if (typeof tname === "string" && isObject(raw.schema) && raw.schema.type === "object" && typeof raw.description === "string" && raw.description.trim()) {
        tools.push({ name: tname, description: raw.description, schema: raw.schema as JsonSchema });
      }
    }
  }

  if (errs.length) throw new PluginError("invalid", errs.join("; "));

  return {
    id: id as string,
    name: (name as string).trim(),
    version: version as string,
    description: description as string,
    permissions,
    config,
    tools,
  };
}

/** Type-checks supplied config values against the manifest's declared fields. */
export function validateConfig(
  manifest: PluginManifest,
  values: unknown,
  opts: { requireComplete?: boolean } | boolean = {},
): PluginConfig {
  const requireComplete = typeof opts === "boolean" ? opts : (opts.requireComplete ?? false);
  if (!isObject(values)) throw new PluginError("invalid", "config must be an object");
  const errs: string[] = [];
  const out: PluginConfig = {};
  const declared = new Map(manifest.config.map((f) => [f.name, f]));
  for (const key of Object.keys(values)) {
    if (!declared.has(key)) errs.push(`unknown config field "${key}"`);
  }
  for (const field of manifest.config) {
    const v = values[field.name];
    if (v === undefined || v === null || v === "") {
      if (requireComplete && field.required) errs.push(`"${field.name}" is required`);
      continue;
    }
    if (typeof v !== field.type) errs.push(`"${field.name}" must be ${field.type}`);
    else if (typeof v === "string" && v.length > 4096) errs.push(`"${field.name}" exceeds 4096 chars`);
    else out[field.name] = v as string | number | boolean;
  }
  if (errs.length) throw new PluginError(requireComplete ? "config_missing" : "invalid", errs.join("; "));
  return out;
}

export const maskConfig = (
  manifest: PluginManifest,
  config: PluginConfig,
): PluginConfigView => {
  const out: PluginConfigView = {};
  for (const field of manifest.config) {
    const v = config[field.name];
    if (v === undefined) continue;
    out[field.name] = field.secret ? "••••••" : v;
  }
  return out;
};

export type PluginConfig = Record<string, string | number | boolean>;
/** Config as the API reports it: secret values are replaced, never echoed. */
export type PluginConfigView = Record<string, string | number | boolean>;

/** Persisted plugin state. Secrets inside `config` never leave the server. */
export interface PluginRecord {
  id: string;
  enabled: boolean;
  manifest: PluginManifest;
  config: PluginConfig;
  installedAt: number;
  updatedAt: number;
}

/** What the API and the UI see: no secret values, ever. */
export interface PluginView {
  id: string;
  name: string;
  version: string;
  description: string;
  permissions: Permission[];
  config: ConfigField[];
  /** Secret fields are reported as set/unset and never echoed. */
  configValues: PluginConfigView;
  missingRequired: string[];
  tools: string[];
  installed: boolean;
  enabled: boolean;
  updatedAt: number;
}

/** Required config fields that have no value yet, in declaration order. */
export function missingRequired(manifest: PluginManifest, config: PluginConfig): string[] {
  return manifest.config
    .filter((f) => f.required && (config[f.name] === undefined || config[f.name] === ""))
    .map((f) => f.name);
}

/**
 * Builds the API/UI view of a plugin. `registeredTools` is the live tool
 * registry, which is how the view knows a plugin's tools are actually callable
 * right now rather than merely declared in a manifest.
 */
export function toView(rec: PluginRecord, registeredTools: string[] = []): PluginView {
  const tools = rec.manifest.tools.map((t) => t.name);
  const live = new Set(registeredTools);
  return {
    id: rec.id,
    name: rec.manifest.name,
    version: rec.manifest.version,
    description: rec.manifest.description,
    permissions: rec.manifest.permissions,
    config: rec.manifest.config,
    configValues: maskConfig(rec.manifest, rec.config),
    missingRequired: missingRequired(rec.manifest, rec.config),
    tools,
    installed: tools.every((t) => live.has(t)),
    enabled: rec.enabled,
    updatedAt: rec.updatedAt,
  };
}
