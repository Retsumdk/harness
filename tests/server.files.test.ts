import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatService, MemoryStore, MockProvider, ToolRegistry, Workspace } from "../src";
import { createApp } from "../src/server/app";

const TOKEN = "files-token";
const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

function build() {
  const root = mkdtempSync(join(tmpdir(), "harness-files-"));
  const workspace = new Workspace(root);
  const store = new MemoryStore();
  const chat = new ChatService(store, new Map([["mock", new MockProvider()]]), new ToolRegistry());
  const app = createApp({ store, chat, token: TOKEN, workspace, version: "9.9.9", tools: () => ["fs.read"] });
  return { app, workspace, store, root, done: () => rmSync(root, { recursive: true, force: true }) };
}

const get = (app: ReturnType<typeof build>["app"], path: string) => app.request(path, { headers: auth });
const call = (app: ReturnType<typeof build>["app"], method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });

describe("files API", () => {
  test("the root of a fresh workspace is an empty directory, not a 404", async () => {
    const b = build();
    try {
      const res = await get(b.app, "/api/files?path=.");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ type: "dir", path: ".", entries: [] });
    } finally { b.done(); }
  });

  test("a write creates the file and a list shows it with its size", async () => {
    const b = build();
    try {
      expect((await call(b.app, "PUT", "/api/files?path=notes/today.md", { content: "hello" })).status).toBe(200);
      const listing = await (await get(b.app, "/api/files?path=notes")).json();
      expect(listing.type).toBe("dir");
      expect(listing.entries).toEqual([{ name: "today.md", kind: "file", path: "notes/today.md", size: 5 }]);
    } finally { b.done(); }
  });

  test("reading a file returns its content and size", async () => {
    const b = build();
    try {
      b.workspace.write("a.txt", "line one\nline two");
      const body = await (await get(b.app, "/api/files?path=a.txt")).json();
      expect(body).toMatchObject({ type: "file", path: "a.txt", content: "line one\nline two", size: 17 });
    } finally { b.done(); }
  });

  test("a path that escapes the workspace is a 400, not a read of the host", async () => {
    const b = build();
    try {
      const res = await get(b.app, `/api/files?path=${encodeURIComponent("../../etc/passwd")}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("bad_request");
    } finally { b.done(); }
  });

  test("a missing file is 404 and a directory write is refused", async () => {
    const b = build();
    try {
      expect((await get(b.app, "/api/files?path=nope.txt")).status).toBe(404);
      b.workspace.write("dir/x.txt", "x");
      const res = await call(b.app, "PUT", "/api/files?path=dir", { content: "oops" });
      expect(res.status).toBe(400);
    } finally { b.done(); }
  });

  test("the write body is validated server-side: content must be a string", async () => {
    const b = build();
    try {
      const res = await call(b.app, "PUT", "/api/files?path=x.txt", { content: 42 });
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toContain("content");
      expect((await call(b.app, "PUT", "/api/files", { content: "x" })).status).toBe(400);
    } finally { b.done(); }
  });

  test("search needs a query and returns path/line/text hits", async () => {
    const b = build();
    try {
      b.workspace.write("notes/a.md", "first\nfind me here\n");
      const empty = await get(b.app, "/api/files/search?q=");
      expect(empty.status).toBe(400);
      const hits = await (await get(b.app, "/api/files/search?q=find%20me")).json();
      expect(hits.results).toEqual([{ path: "notes/a.md", line: 2, text: "find me here" }]);
    } finally { b.done(); }
  });

  test("a delete removes the file and a second delete is a 404", async () => {
    const b = build();
    try {
      b.workspace.write("gone.txt", "x");
      expect((await call(b.app, "DELETE", "/api/files?path=gone.txt")).status).toBe(200);
      expect((await call(b.app, "DELETE", "/api/files?path=gone.txt")).status).toBe(404);
    } finally { b.done(); }
  });

  test("every files route needs the bearer token", async () => {
    const b = build();
    try {
      const res = await b.app.request("/api/files?path=.");
      expect(res.status).toBe(401);
    } finally { b.done(); }
  });
});

describe("settings API", () => {
  test("the payload names the providers, tools, workspace and version the instance really has", async () => {
    const b = build();
    try {
      const body = await (await get(b.app, "/api/settings")).json();
      expect(body.providers).toEqual(["mock"]);
      expect(body.defaultProvider).toBe("mock");
      expect(body.tools).toEqual(["fs.read"]);
      expect(body.version).toBe("9.9.9");
      expect(body.settings).toEqual({ provider: "", model: "" });
      expect(body.workspace).toBe(b.workspace.root);
    } finally { b.done(); }
  });

  test("saved defaults are persisted and returned on the next read", async () => {
    const b = build();
    try {
      const res = await call(b.app, "PUT", "/api/settings", { provider: "mock", model: "gpt-test" });
      expect(res.status).toBe(200);
      const body = await (await get(b.app, "/api/settings")).json();
      expect(body.settings).toEqual({ provider: "mock", model: "gpt-test" });
    } finally { b.done(); }
  });

  test("an unknown provider is refused with the known list, and nothing is written", async () => {
    const b = build();
    try {
      const res = await call(b.app, "PUT", "/api/settings", { provider: "made-up" });
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toContain("mock");
      const body = await (await get(b.app, "/api/settings")).json();
      expect(body.settings.provider).toBe("");
    } finally { b.done(); }
  });

  test("a model name longer than 120 characters is refused", async () => {
    const b = build();
    try {
      const res = await call(b.app, "PUT", "/api/settings", { model: "x".repeat(121) });
      expect(res.status).toBe(400);
    } finally { b.done(); }
  });

  test("chat uses the saved provider and model when the request names none", async () => {
    const b = build();
    try {
      await call(b.app, "PUT", "/api/settings", { provider: "mock", model: "gpt-saved" });
      const res = await b.app.request("/api/chat", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ message: "hello" }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      const streamed = text.split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)))
        .filter((event) => event.type === "token")
        .map((event) => event.text)
        .join("");
      expect(streamed).toBe("You said: hello");
    } finally { b.done(); }
  });
});
