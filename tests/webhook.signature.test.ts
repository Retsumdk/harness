/**
 * The webhook tool must sign exactly what it posts. A receiver checks that header to
 * decide the event is really from us, so the digest is compared against an
 * independent implementation (node:crypto in the test) rather than itself.
 */
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { MemoryStore, PluginService, ToolRegistry } from "../src";
import { isPublicTarget, signBody } from "../src/plugins/builtins/webhook";

const SECRET = "whsec_test_123";
const oracle = (body: string) => createHmac("sha256", SECRET).update(body).digest("hex");

function build(opts: { reply?: () => Response; target?: string } = {}) {
  const store = new MemoryStore();
  const tools = new ToolRegistry();
  const sent: { url: string; init?: RequestInit }[] = [];
  const plugins = new PluginService({
    store,
    tools,
    fetchImpl: async (url, init) => {
      sent.push({ url: String(url), init });
      return opts.reply ? opts.reply() : new Response("ok", { status: 202 });
    },
  });
  return { store, tools, sent, plugins };
}

describe("webhook signing", () => {
  test("signBody matches HMAC-SHA256 hex from an independent implementation", async () => {
    const body = JSON.stringify({ event: "release", payload: { version: "0.4.0" } });
    expect(await signBody(SECRET, body)).toBe(oracle(body));
  });

  test("the digest is 64 lowercase hex characters and changes with the secret", async () => {
    const digest = await signBody(SECRET, "hello");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await signBody("other-secret", "hello")).not.toBe(digest);
  });

  test("a sent event carries a signature the receiver can verify", async () => {
    const { plugins, tools, sent } = build();
    await plugins.configure("webhook", { url: "https://example.com/hook", secret: SECRET });
    await plugins.enable("webhook");

    const result = (await tools.call("webhook.send", { event: "release", payload: { version: "0.4.0" } })) as {
      status: number;
      delivered: boolean;
    };

    expect(result).toEqual({ status: 202, event: "release", delivered: true } as never);
    const posted = sent[0].init as RequestInit;
    const headers = posted.headers as Record<string, string>;
    expect(headers["x-harness-event"]).toBe("release");
    expect(headers["x-harness-signature"]).toBe(`sha256=${oracle(String(posted.body))}`);
  });

  test("no secret means no signature header rather than an empty one", async () => {
    const { plugins, tools, sent } = build();
    await plugins.configure("webhook", { url: "https://example.com/hook" });
    await plugins.enable("webhook");
    await tools.call("webhook.send", { event: "ping" });
    const headers = (sent[0].init as RequestInit).headers as Record<string, string>;
    expect(headers["x-harness-signature"]).toBeUndefined();
  });

  test("the webhook target must be a public host", async () => {
    const { plugins, tools } = build();
    await plugins.configure("webhook", { url: "http://127.0.0.1:9000/hook" });
    await plugins.enable("webhook");
    const error = await tools.call("webhook.send", { event: "ping" }).catch((e) => e as Error);
    expect((error as Error).message).toContain("public http(s) host");
    expect(isPublicTarget("https://example.com/hook")).toBe(true);
  });

  test("a non-2xx endpoint is reported as a failed delivery, not a success", async () => {
    const { plugins, tools } = build({ reply: () => new Response("nope", { status: 503 }) });
    await plugins.configure("webhook", { url: "https://example.com/hook" });
    await plugins.enable("webhook");
    const error = await tools.call("webhook.send", { event: "ping" }).catch((e) => e as Error);
    expect((error as Error).message).toContain("responded 503");
  });
});
