import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace, FsError } from "../src/fs/workspace";

let ws: Workspace; let outside: string;
beforeEach(() => { const base = mkdtempSync(join(tmpdir(), "h-")); outside = join(base, "outside"); ws = new Workspace(join(base, "ws"), 100); });

test("write/read/list/delete roundtrip", () => {
  ws.write("a/b.txt", "hello"); expect(ws.read("a/b.txt")).toBe("hello");
  expect(ws.list("a")).toEqual([{ name: "b.txt", dir: false }]);
  expect(ws.list()).toEqual([{ name: "a", dir: true }]);
  ws.delete("a"); expect(() => ws.read("a/b.txt")).toThrow(FsError);
});
test("../ traversal blocked", () => { expect(() => ws.read("../x")).toThrow(/escapes/); expect(() => ws.write("a/../../x", "1")).toThrow(FsError); });
test("absolute path is rooted inside workspace", () => { ws.write("/etc/passwd", "x"); expect(ws.read("etc/passwd")).toBe("x"); });
test("null byte blocked", () => expect(() => ws.read("a\0b")).toThrow(FsError));
test("symlink escape blocked", () => {
  writeFileSync(outside, "secret");
  symlinkSync(outside, join(ws.root, "link"));
  expect(() => ws.read("link")).toThrow(/symlink/);
});
test("not found and size limits", () => {
  expect(() => ws.read("none")).toThrow(/no such file/); expect(() => ws.list("none")).toThrow(FsError); expect(() => ws.delete("none")).toThrow(FsError);
  expect(() => ws.write("big", "x".repeat(101))).toThrow(/exceeds/);
  writeFileSync(join(ws.root, "big2"), "x".repeat(101)); expect(() => ws.read("big2")).toThrow(/exceeds/);
});
test("cannot delete root", () => expect(() => ws.delete(".")).toThrow(/root/));
test("search finds lines", () => { ws.write("d/n.txt", "one\nneedle here"); ws.write("m.txt", "needle"); const r = ws.search("needle"); expect(r.length).toBe(2); expect(ws.search("needle", 1).length).toBe(1); });
