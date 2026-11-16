import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/store/sqlite";

test("a closed SQLite store refuses further work instead of silently reopening", async () => {
  const store = new SqliteStore(join(mkdtempSync(join(tmpdir(), "closed-")), "harness.db"));
  const conversation = await store.createConversation("before close");
  expect((await store.listConversations()).map((c) => c.id)).toEqual([conversation.id]);
  await store.close();
  await expect(store.listConversations()).rejects.toBeDefined();
});
