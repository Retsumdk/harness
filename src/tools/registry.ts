export type JsonSchema = {
  type: "object";
  properties: Record<string, { type: "string" | "number" | "boolean" | "array" | "object"; enum?: unknown[]; maxLength?: number }>;
  required?: string[];
  additionalProperties?: boolean;
};

export interface Tool {
  name: string;
  description: string;
  schema: JsonSchema;
  run(args: Record<string, unknown>): Promise<unknown> | unknown;
}

export class ToolError extends Error {
  constructor(public code: "unknown_tool" | "invalid_args" | "duplicate" | "failed", message: string) {
    super(message);
  }
}

export function validateArgs(schema: JsonSchema, args: unknown): string[] {
  const errs: string[] = [];
  if (typeof args !== "object" || args === null || Array.isArray(args)) return ["arguments must be an object"];
  const a = args as Record<string, unknown>;
  for (const key of schema.required ?? []) if (!(key in a)) errs.push(`missing required "${key}"`);
  for (const [key, val] of Object.entries(a)) {
    const spec = schema.properties[key];
    if (!spec) {
      if (schema.additionalProperties === false || schema.additionalProperties === undefined) errs.push(`unexpected "${key}"`);
      continue;
    }
    const actual = Array.isArray(val) ? "array" : typeof val;
    if (val === null || actual !== spec.type) { errs.push(`"${key}" must be ${spec.type}`); continue; }
    if (spec.enum && !spec.enum.includes(val)) errs.push(`"${key}" must be one of ${spec.enum.join(", ")}`);
    if (spec.maxLength !== undefined && typeof val === "string" && val.length > spec.maxLength) errs.push(`"${key}" exceeds ${spec.maxLength} chars`);
  }
  return errs;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) throw new ToolError("duplicate", `tool "${tool.name}" already registered`);
    this.tools.set(tool.name, tool);
  }
  list(): { name: string; description: string; schema: JsonSchema }[] {
    return [...this.tools.values()].map(({ name, description, schema }) => ({ name, description, schema }));
  }
  has(name: string): boolean {
    return this.tools.has(name);
  }
  /** Removes a tool. Used by plugins/modules that withdraw their tools at runtime. */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }
  names(): string[] {
    return [...this.tools.keys()];
  }
  async call(name: string, args: unknown): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new ToolError("unknown_tool", `unknown tool "${name}"`);
    const errs = validateArgs(tool.schema, args);
    if (errs.length) throw new ToolError("invalid_args", errs.join("; "));
    try {
      return await tool.run(args as Record<string, unknown>);
    } catch (e) {
      if (e instanceof ToolError) throw e;
      throw new ToolError("failed", (e as Error).message);
    }
  }
}
