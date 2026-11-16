# Extending HARNESS

Four seams, in increasing order of how much of the app you take on: **plugins** (integrations),
**tools**, **modules**, and **providers**. Everything below is the same contract the built-ins use —
there is no privileged path.

---

## 1. Plugins — integrations with a manifest

A plugin is a manifest (what it declares) plus an implementation (what it does). The manifest is
untrusted input and is validated before anything is stored or registered; every problem is
reported at once so a manifest can be fixed in one pass.

```ts
import type { PluginManifest } from "../src/plugins/types";
import type { PluginImplementation, PluginRuntime } from "../src/plugins/service";

const manifest: PluginManifest = {
  id: "weather",                 // 2–39 chars, lowercase letters/digits/dashes, starts with a letter
  name: "Weather",
  version: "1.0.0",              // semver
  description: "Current conditions for a city.",
  permissions: ["network"],      // declared, not implied
  config: [
    { name: "apiKey", type: "string", required: true, secret: true,
      description: "Issued by the provider; stored server-side." },
    { name: "units", type: "string", required: false, description: "metric or imperial." },
  ],
  tools: [
    {
      name: "weather.current",   // namespaced: <plugin>.<snake_case>
      description: "Read the current conditions for one city.",
      schema: {
        type: "object",
        properties: { city: { type: "string", maxLength: 100 } },
        required: ["city"],
      },
    },
  ],
};

export function weatherPlugin(): PluginImplementation {
  return {
    manifest,
    handlers: {
      "weather.current": async (args, ctx: PluginRuntime) => {
        const url = `https://api.example.com/now?q=${encodeURIComponent(String(args.city))}`;
        const res = await ctx.fetch(url, { headers: { "x-api-key": String(ctx.config.apiKey) } });
        if (!res.ok) throw new Error(`provider returned ${res.status}`);
        return await res.json();
      },
    },
  };
}
```

Register it at boot, next to the built-ins:

```ts
plugins.registerImplementation(weatherPlugin());
```

Lifecycle, in the order the service enforces it:

| Step | Called by | Effect |
|---|---|---|
| `install(manifest)` | `POST /api/plugins` | validated, stored **disabled**; no tools registered |
| `configure(id, values)` | `PUT /api/plugins/:id/config` | merged and type-checked; unknown keys rejected; a running plugin re-registers its tools |
| `enable(id)` | `POST /api/plugins/:id/enable` | required config fields must be present; tools enter the live registry; emits `plugin:enabled` |
| `disable(id)` | `POST /api/plugins/:id/disable` | tools withdrawn from the registry; emits `plugin:disabled` |
| `uninstall(id)` | `DELETE /api/plugins/:id` | refused while enabled; removes the stored record |

A built-in that has never been written to the store is materialised as installed-but-disabled the
first time a client acts on it, so the list you see and the objects you can act on are the same set.

**Rules the validator enforces.** `id` matches `^[a-z][a-z0-9-]{1,38}$`; `version` is `x.y.z`;
tool names match `^[a-z][a-z0-9-]*\.[a-z][a-z0-9_]*$` (namespaced by plugin); config field names
match `^[A-Za-z_][A-Za-z0-9_]{0,39}$`; at most 20 tools; no unknown keys anywhere; `permissions`
must be drawn from the list in §5.

**Two behaviours worth copying from the built-ins.** `github` marks its token `secret: true`, so
every API response returns it as `••••••` and the value itself never leaves the server.
`webhook` refuses any target that is not a public host — loopback, link-local, private ranges and
`.local` are rejected before the request is made — and signs the body with HMAC-SHA256
when a secret is configured, using WebCrypto so the same code runs in the browser demo.

---

## 2. Tools — the model's only way to act

```ts
import type { Tool } from "../src/tools/registry";

export const wordCount: Tool = {
  name: "text.word_count",
  description: "Count words in a string.",
  schema: {
    type: "object",
    properties: { text: { type: "string", maxLength: 20000 } },
    required: ["text"],
  },
  run: (args) => ({ words: String(args.text).trim().split(/\s+/).filter(Boolean).length }),
};

tools.register(wordCount);
```

Arguments are validated against the schema before `run` is called: required keys, primitive types,
`enum`, `maxLength`, and no unexpected keys (the schema is closed by default). A duplicate name
throws; `unregister(name)` withdraws a tool, which is how plugin disable works.

An agent only sees the tools in its own allowlist, and the allowlist is enforced at call time, not
just when the run is created. `shell.run` is the sharp one: command allowlist, fixed working
directory, 5 s timeout, 64 kB output cap, no shell interpolation (`spawn` with `shell: false`).

---

## 3. Modules — the environment's skeleton

```ts
import type { Module } from "../src/core/registry";

const billing: Module = {
  id: "billing",
  version: "0.1.0",
  requires: ["core"],
  start: async (ctx) => {
    const off = ctx.bus.on("plugin:enabled", (e) => console.log("plugin came up", e));
    // keep `off` if the module needs to unsubscribe on stop
  },
  stop: async () => { /* release handles; tools it registered are withdrawn */ },
};

registry.register(billing);
```

`requires` is a dependency graph. Start order is dependency-first (a cycle or a missing dependency
throws with the path that produced it), `disable` refuses while another running module still
requires this one (`in_use`), and a stopped module's HTTP routes answer `409 module_disabled`
rather than silently serving. Enable and disable at runtime with `POST /api/modules/:id/enable`
and `/disable`, or from the switchboard in Settings; `GET /api/modules` lists state, dependencies
and live dependants.

Built-in modules: `core`, `fs`, `tools`, `providers`, `chat`, `agents`, `plugins`.

**Events** on the bus (`ctx.bus.on(topic, handler)` returns an unsubscribe function):
`module:started`, `module:stopped`, `plugin:enabled`, `plugin:disabled`, `plugin:configured`.

---

## 4. Providers — where the tokens come from

```ts
import type { Provider, Chunk, ChatMessage, ToolSpec, StreamOptions } from "../src/providers/types";

class LocalProvider implements Provider {
  id = "local";
  async *stream(messages: ChatMessage[], tools: ToolSpec[] = [], opts: StreamOptions = {}): AsyncIterable<Chunk> {
    // yield { type: "token", text } … then exactly one of:
    //   { type: "tool_call", call: { id, name, args } }
    //   { type: "done", usage: { promptTokens, completionTokens } }
  }
}
```

Providers are a map keyed by id, assembled in `defaultProviders()` from the environment. Add yours
there (or pass `providers` to `createHarness`) and it appears in the chat header and in
`GET /health`'s module list. `mock` is always present so the app boots with no keys; the
OpenAI-compatible provider covers any endpoint that speaks chat completions, which is most of them.
`opts.signal` aborts a stream when the client disconnects — honour it.

---

## 5. Permission reference

Plugins declare the permissions they need and nothing is inferred:

| Permission | Grants | What it does **not** grant |
|---|---|---|
| `network` | Use `ctx.fetch` to reach a public host | localhost, private ranges, link-local (the webhook plugin's guard is the reference implementation) |
| `filesystem` | Read and write inside `HARNESS_HOME/workspace` | paths outside the workspace root; `..` is rejected by the workspace API |
| `secrets` | Receive `secret: true` config values in `ctx.config` | any route that re-reads them; secrets are masked in every response |

Permissions are declarative metadata today: they are validated, shown in the UI and stored with the
manifest, but the runtime does not block a handler that ignores what it declared. Treat a manifest
from outside your own team as code, not configuration — install it only if you would run its source.

**Other invariants every extension inherits.** A bearer token (`HARNESS_TOKEN`) is required on every
`/api/*` route; there is no client-side-only auth path. Errors use `{error:{code,message}}`. File
paths resolve under the workspace root. Nothing writes a secret to a log, a store response, or the
browser.
