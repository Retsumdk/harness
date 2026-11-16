import { test, expect } from "bun:test";
import { ToolRegistry, ToolError, validateArgs } from "../src/tools/registry";

const schema = { type: "object" as const, properties: { n: { type: "number" as const }, mode: { type: "string" as const, enum: ["a", "b"], maxLength: 1 } }, required: ["n"] };
const mk = () => { const r = new ToolRegistry(); r.register({ name: "t", description: "d", schema, run: (a) => (a.n as number) * 2 }); return r; };

test("valid call runs", async () => expect(await mk().call("t", { n: 2 })).toBe(4));
test("missing required rejected", async () => expect(mk().call("t", {})).rejects.toMatchObject({ code: "invalid_args" }));
test("wrong type rejected", () => expect(validateArgs(schema, { n: "x" })).toEqual(['"n" must be number']));
test("null rejected", () => expect(validateArgs(schema, { n: null })).toEqual(['"n" must be number']));
test("enum and maxLength enforced", () => {
  expect(validateArgs(schema, { n: 1, mode: "cc" }).length).toBe(2);
});
test("unexpected property rejected", () => expect(validateArgs(schema, { n: 1, z: 1 })).toEqual(['unexpected "z"']));
test("additionalProperties true allows extras", () => expect(validateArgs({ ...schema, additionalProperties: true }, { n: 1, z: 1 })).toEqual([]));
test("non-object args rejected", () => { expect(validateArgs(schema, [])).toHaveLength(1); expect(validateArgs(schema, "x")).toHaveLength(1); });
test("unknown tool and duplicate", async () => {
  const r = mk();
  await expect(r.call("nope", {})).rejects.toMatchObject({ code: "unknown_tool" });
  expect(() => r.register({ name: "t", description: "", schema, run: () => 1 })).toThrow(ToolError);
});
test("thrown errors wrapped as failed; list hides run", async () => {
  const r = new ToolRegistry();
  r.register({ name: "x", description: "", schema: { type: "object", properties: {} }, run: () => { throw new Error("boom"); } });
  await expect(r.call("x", {})).rejects.toMatchObject({ code: "failed", message: "boom" });
  expect(Object.keys(r.list()[0]!)).not.toContain("run");
});
