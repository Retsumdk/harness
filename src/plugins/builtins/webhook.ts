import { ToolError } from "../../tools/registry";
import type { PluginManifest } from "../types";
import type { PluginImplementation } from "../service";

/** HMAC-SHA256 over the body, hex encoded. WebCrypto rather than node:crypto so the
 *  same plugin implementation loads in the browser demo as well as the server. */
export async function signBody(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const BLOCKED_HOSTS = [/^localhost$/i, /^127\./, /^0\./, /^10\./, /^192\.168\./, /^169\.254\./, /^::1$/, /^\[::1\]$/, /\.local$/i];

/** Rejects anything that is not a public http(s) host, keeping the webhook tool from probing the host it runs on. */
export function isPublicTarget(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (BLOCKED_HOSTS.some((re) => re.test(url.hostname))) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname)) return false;
  return true;
}

export function webhookPlugin(): PluginImplementation {
  const manifest: PluginManifest = {
    id: "webhook",
    name: "Webhook",
    version: "1.0.0",
    description: "POST signed JSON events to an external public endpoint.",
    permissions: ["network", "secrets"],
    config: [
      { name: "url", type: "string", required: true, description: "Destination URL (public http(s) host)." },
      { name: "secret", type: "string", required: false, secret: true, description: "Optional HMAC-SHA256 signing secret." },
    ],
    tools: [
      {
        name: "webhook.send",
        description: "Send an event to the configured webhook URL. Returns the HTTP status.",
        schema: {
          type: "object",
          properties: {
            event: { type: "string", maxLength: 100 },
            payload: { type: "object" },
          },
          required: ["event"],
        },
      },
    ],
  };

  return {
    manifest,
    handlers: {
      "webhook.send": async (args, rt) => {
        const event = args.event;
        if (typeof event !== "string" || !event.trim()) throw new ToolError("invalid_args", `"event" must be a non-empty string`);
        const payload = args.payload;
        if (payload !== undefined && (typeof payload !== "object" || payload === null || Array.isArray(payload)))
          throw new ToolError("invalid_args", `"payload" must be an object`);

        const target = String(rt.config.url ?? "");
        if (!isPublicTarget(target)) throw new ToolError("failed", "configured webhook url must be a public http(s) host");

        const body = JSON.stringify({ event, payload: payload ?? {}, sentAt: new Date().toISOString() });
        const headers: Record<string, string> = { "content-type": "application/json", "x-harness-event": event };
        if (typeof rt.config.secret === "string" && rt.config.secret)
          headers["x-harness-signature"] = `sha256=${await signBody(rt.config.secret, body)}`;

        const res = await rt.fetch(target, { method: "POST", headers, body });
        if (!res.ok) throw new ToolError("failed", `webhook endpoint responded ${res.status}`);
        return { status: res.status, event, delivered: true };
      },
    },
  };
}
