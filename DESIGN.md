# HARNESS — Design

## Assumptions
1. "Similar to a personal cloud computer with AI" is read as: a **self-hostable, modular AI workspace** — chat with models, files, a sandboxed shell/tools, integrations, and spawnable agents. Not a hosting platform or a clone of any vendor's branding or infrastructure.
2. Stack: TypeScript, Bun runtime, Hono server, React + Vite + Tailwind client, SQLite (bun:sqlite) persistence, Vitest/bun test. Client left it open; this is one language end to end and fast to start.
3. Model access is through a **provider interface** (OpenAI-compatible, Anthropic, local OpenAI-compatible endpoints). Keys come from env/UI settings, never committed. A deterministic **Mock provider** ships so the app and demo work with zero keys.
4. Integrations are **plugins** with a manifest (tools + optional OAuth/API-key config). Shipped built-ins: HTTP fetch, GitHub (token), Webhook, Filesystem. Third-party OAuth apps are out of scope beyond the plugin contract and are listed as exclusions in DELIVERY.md.
5. "Spawn functional agents" = an agent is a persisted definition (name, system prompt, model, tool allowlist, budget) run by a loop (plan → tool call → observe → finish) with step and token caps. Agents can spawn child agents (depth-capped at 3).
6. Shell/code execution is sandboxed to a per-workspace directory with command allowlist, timeout and output cap; no network sandboxing claims beyond that.
7. The public demo is a **static build** (GitHub Pages, rung 1): the kernel runs in-browser against IndexedDB-backed storage and the Mock provider; the full server build is the repo's primary product. Both share the `core` package.
8. Single-user, local-first. Auth is a single bearer token (`HARNESS_TOKEN`) on the server; multi-tenant is excluded.
9. Budget "to-discuss" and timeline "ASAP" do not change scope; quality floor in the manual applies.

## Requirement ledger (from brief)
| # | Requirement | Met |
|---|---|---|
| R1 | Workspace environment with capabilities comparable to an AI-native personal computer (files, terminal/tools, chat, apps) | met — chat, file browser/editor, sandboxed `shell.run` tool, agent runner and a pluggable app surface, all served from one process (M3–M6) |
| R2 | AI accessibility: UI, HTTP API, and CLI all reach the same capabilities | met — the CLI is a thin client of the same HTTP API (M7) |
| R3 | AI chat with streaming, history, multiple providers/models | met — SSE streaming, persisted history, provider select in the chat header, mock + any OpenAI-compatible endpoint (M3, M6) |
| R4 | Integrations capability via plugin system | met — declarative manifests (permissions, config schema, namespaced tools) validated server-side, runtime enable/disable/configure, built-ins `github` + `webhook`, `/api/plugins` routes, secrets masked in every response |
| R5 | Modular environment: modules enabled/disabled at runtime, documented extension API | met — runtime module enable/disable with dependency protection and `/api/modules` (M5), plus `docs/EXTENDING.md`: module contract, tool contract, provider contract, plugin manifest and the permission reference (M8) |
| R6 | Spawn functional AI agents (definitions, runs, child agents, tools) | met — definitions CRUD + validation, run loop with tool allowlist and budgets, child spawn capped at depth 3, run viewer with live steps and cancel (M4, M6); the live view reaches the terminal status after round 1 (timer-driven stream, `tests/demo.kernel.test.ts` — "an agent run watched from mid-flight streams to done and succeeded"); a cold deep link to `/<repo>/runs/<id>` and a reload of the run page both render the run with its steps and its terminal status, and a `/files?path=…` URL opens that folder (`src/demo/fallback.ts`, `pathFromSearch` in `src/web/pages/Files.tsx`) |
| R7 | Swift and efficient: cold start < 1s, chat first token path non-blocking, bounded memory | met — `bun run perf` measures cold start to `/health` 200 at 44–45ms and 100 concurrent SSE chats finishing in 83ms with +20MB RSS and all 100 conversations persisted (M8) |
| R8 | Thorough, complete, refined: docs, tests, empty/error/loading states, CI | met — 261 tests green, 83.18% funcs / 87.56% lines, empty/error/loading states on every panel, `README.md` with a three-command run, `.env.example`, `.github/workflows/ci.yml`, `KNOWN-DEFECTS.md` (M8); a deep link or a reload of any sub-route in the static demo boots the app from the generated `404.html` (`src/demo/fallback.ts`, `tests/demo.fallback.test.ts`); CI is defined but cannot run green until the repo is pushed at DELIVER |

## Modules (`packages/`)
- `core` — module registry, event bus, config, lifecycle (enable/disable/dependency order).
- `providers` — `Provider` interface (`stream(messages, tools) -> AsyncIterable<Chunk>`); openai-compat, anthropic, mock.
- `chat` — conversations, messages, streaming, tool-call routing.
- `tools` — tool registry with JSON-schema args validation; built-ins: fs, shell(sandboxed), http, notes.
- `fs` — workspace file API (list/read/write/delete/search), path-escape protection.
- `agents` — definitions, runner loop, child spawn, run log, budgets, cancel.
- `plugins` — manifest loader, permission declaration, built-ins: github, webhook.
- `store` — SQLite (server) and IndexedDB (browser) behind one `Store` interface.
- `server` — Hono routes + SSE, bearer auth, static client hosting.
- `web` — React UI: Chat, Files, Agents, Plugins, Settings.
- `cli` — `harness chat|run-agent|ls|plugins`.

## Data model
`conversations(id, title, agent_id?, created_at)`, `messages(id, conversation_id, role, content, tool_calls json, created_at)`, `agents(id, name, system_prompt, model, provider, tools json, max_steps, max_tokens, parent_id?, created_at)`, `runs(id, agent_id, parent_run_id?, status, input, output, steps json, started_at, ended_at)`, `plugins(id, enabled, config json)`, `settings(key, value)`. Files live on disk under `HARNESS_HOME/workspace`.

## API contracts (all JSON, bearer auth except /health)
- `GET /health` → `{ok, version, modules[]}`
- `POST /api/chat` `{conversationId?, message, provider?, model?}` → SSE: `token`, `tool_call`, `tool_result`, `done`
- `GET/DELETE /api/conversations[/:id]`
- `GET/PUT/DELETE /api/files?path=` ; `GET /api/files/search?q=`
- `GET/POST/PUT/DELETE /api/agents[/:id]`
- `POST /api/agents/:id/runs` `{input}` → `{runId}`; `GET /api/runs/:id` (steps, status); `POST /api/runs/:id/cancel`; SSE `/api/runs/:id/stream`
- `GET /api/plugins`; `POST /api/plugins/:id/enable|disable`; `PUT /api/plugins/:id/config`
- `GET /api/modules`; `POST /api/modules/:id/enable|disable`
- Errors: `{error:{code,message}}` with 400/401/404/409/429.

## Milestones (each ends with named passing tests and a commit)
1. **M1 Core + store + providers — DONE (tests passing: core.registry.test, store.contract.test, providers.mock.test)** — registry with dependency ordering, event bus, Store (SQLite + in-memory), Mock + OpenAI-compat providers. DoD: `core.registry.test`, `store.contract.test`, `providers.mock.test` green.
2. **M2 Tools, fs, sandboxed shell — DONE (tests passing: fs.escape.test, shell.sandbox.test, tools.validation.test)** — schema-validated tool registry; path-escape, timeout and output-cap tests. DoD: `fs.escape.test`, `shell.sandbox.test`, `tools.validation.test`.
3. **M3 Chat service + server — DONE (tests passing: chat.stream.test, server.auth.test, server.errors.test)** — streaming SSE chat with tool-call loop, auth, error contract. DoD: `chat.stream.test`, `server.auth.test`, `server.errors.test`.
4. **M4 Agents — DONE (tests passing: agents.runner.test, agents.budget.test, agents.spawn-depth.test)** — definitions CRUD with server-side validation, runner loop (plan → tool → observe → finish), tool allowlist enforced at run time, token and step budgets, cooperative cancel, child spawn with a depth cap of 3, run persistence plus SSE replay at `/api/runs/:id/stream`. DoD: `agents.runner.test`, `agents.budget.test`, `agents.spawn-depth.test`.
5. **M5 Plugins + modules — DONE (tests passing: plugins.manifest.test, modules.toggle.test)** — manifest validation (id/version/permission/config/tool-namespace rules, all errors reported at once), plugin lifecycle install→configure→enable→disable→uninstall with tools registered and withdrawn from the live ToolRegistry, secrets masked, SSRF guard on webhooks; module service over the registry with dependency-first start, `in_use` protection and `/api/modules` + `/api/plugins` routes. DoD: `plugins.manifest.test`, `modules.toggle.test`.
6. **M6 Web UI — DONE (tests passing: web.views.test, web.api.test, web.runtime.test, server.files.test, seed.test; smoke: scripts/smoke.ts)** — Chat (streaming, tool calls, provider select), Files (browse, edit, search, create, delete), Agents (definitions, editor, run history), run viewer (steps, tool args/results, cancel, live SSE), Plugins (config, enable/disable, uninstall, module switchboard), Settings (provider/model defaults, instance facts, sign out), plus a home dashboard. Hand-written empty/loading/error states on every panel, a 404 route with a way back, bearer-token sign-in, and first-run seed data. Server additions the UI needed: `/api/files` (list/read/write/delete/search), `/api/settings`, `GET /api/runs`, and a module gate that closes a stopped module's routes with 409. DoD: the five named test files above, plus `bun run smoke` printing `RESULT: PASS`.
7. **M7 CLI + static demo build — DONE (tests passing: cli.test, demo.kernel.test, webhook.signature.test; demo smoke: h1 reads 'HARNESS workspace' at a hosted sub-path, Files lists the three seed files)** — `harness chat|run-agent|ls|files|plugins|agents|health` as a thin client of the HTTP API (`src/cli/run.ts`, 30 tests through a real app), plus a static demo build (`bun run build:demo` → `demo/`) that runs the same Hono app, routes and services inside the tab: `MemoryWorkspace` over `WorkspaceLike`, `PersistentStore` over localStorage, mock provider, and `bin/deploy-demo.sh` staging it for GitHub Pages. DoD: `cli.test`, demo smoke `h1 contains 'HARNESS'`, seeded conversation and two sample agents visible on first load — all met.
8. **M8 Hardening and docs — DONE (tests passing: run.recovery.test, shell.sandbox.test, store.contract.test, web.runtime.test; perf gate: `bash bin/perf-check.sh`)** — `README.md` (three-command run, feature map, API table, CLI, troubleshooting), `.env.example`, `.github/workflows/ci.yml` (typecheck, tests, coverage ≥ 80%, both builds, smoke, perf), `KNOWN-DEFECTS.md` (12 P2s, none open at P0/P1), `docs/EXTENDING.md` (module/tool/provider/plugin contracts + permission reference), `scripts/perf-check.ts` behind `bin/perf-check.sh`. Two defects found and fixed while hardening: an interrupted run used to stay `running` for ever after a crash (boot now closes it as `failed`, `run.recovery.test`), and `shell.run` accepted `..` or absolute arguments, which walked out of the workspace (now refused, `shell.sandbox.test`). DoD: `bun run perf` prints `RESULT: PASS`, `bun run smoke` prints `RESULT: PASS`, coverage ≥ 80%, and every command in the README run from a clean clone.

## M6 implementation notes (decisions taken while building the UI)
- **No Tailwind.** The client uses one hand-written token sheet (`src/web/styles.css`, ~13 kB built) instead of Tailwind. Rationale: it removes a build plugin and a content-scan step from a two-file bundle, and the token names (`--bg`, `--panel`, `--accent`) double as the design vocabulary for QA. Same visual system, one fewer moving part.
- **No router dependency.** `src/web/router.tsx` is a ~90-line history router: `ROUTE_PATTERNS` is the single route table, `matchRoute` is pure and tested, and `Link` renders a real `href` so middle-click still works.
- **Two layers per screen.** Each page exports a presentational view (`ChatView`, `FilesView`, …) and a container (`ChatPage`) that owns fetching. The views are rendered server-side in tests, so empty/loading/error copy is asserted without a DOM.
- **Sign-in, not token injection.** The UI never receives the token from the server; the person pastes `HARNESS_TOKEN` once and it is kept in `localStorage`. Injecting it into `index.html` would hand the credential to anyone who could load the page.
- **`/api/files` returns the listing or the file** depending on the path's kind, so one endpoint covers browse and read without a second route to keep in sync.

## M8 implementation notes (hardening)
- **The perf gate is a script, not a claim.** `scripts/perf-check.ts` spawns the real server three times and times spawn → `/health` 200 (44–45ms), then serves `createHarness` in-process and drives 100 concurrent `POST /api/chat` streams to completion, asserting zero failures, a wall-clock ceiling and RSS growth. `bin/perf-check.sh` is the thin, documented entry point.
- **Crash recovery closes runs, it does not resume them.** A run interrupted by a restart is marked `failed` with a one-line error at boot (`recoverInterruptedRuns` in `src/server/main.ts`), so the UI stops showing a spinner that can never finish. Resuming a half-finished tool loop would need a durable step journal; that is listed as a P2, not pretended.
- **The shell argument rule is a deny-list of escapes, not a jail.** `..` segments and absolute paths are refused before spawn, which keeps the documented "sandboxed to the workspace" promise honest for the five allowlisted read-only commands. It is not a syscall sandbox and `KNOWN-DEFECTS.md` says so.
- **CI is defined here and proven at DELIVER.** The workflow cannot be green before the repository is pushed; the gate is recorded as `defined, unverified` until then rather than claimed.

## Definition of done (job)
All R1–R8 met; build clean; tests green; coverage ≥ 80%; CI green; private repo `Retsumdk/harness` with `retsumdk@gmail.com` as collaborator; public demo answering 200; `verify-delivery.sh` prints `RESULT: PASS`.

## Scope notes for the client (in DELIVERY.md)
Excluded unless agreed in writing: replicating any vendor's hosted infrastructure, multi-tenant accounts/billing, third-party OAuth apps beyond the plugin contract, container-level sandboxing.

## M7 implementation notes (CLI and the in-tab build)
- **The CLI is a client, not a second server.** `src/cli/run.ts` takes `{stdout, stderr, env, fetchImpl}` and drives the published API, so `argv` parsing, exit codes and stream rendering are tested against a real app instance without opening a port. Exit codes: 0 done, 1 the server refused or could not be reached, 2 usage.
- **The demo runs the server, not a mock of it.** `createDemoKernel` assembles the same `createApp` the server uses over a `MemoryWorkspace` and a `PersistentStore` (one JSON document in localStorage). Only two things differ from production: the model is the mock provider and there is no shell. The tab therefore exercises the real routes, the real tool loop and the real module registry.
- **`WorkspaceLike` is the seam.** Extracting the filesystem contract into `src/fs/types.ts` let the routes, the seed and the fs tools accept either the disk workspace or the in-memory one; no route learned about the browser.
- **The workspace is not persisted, the store is.** After a reload the store still says "seeded", so the demo re-writes the three seed files whenever the workspace comes up empty (`writeSeedFiles`). Without this the Files tab emptied itself on refresh.
- **A hosted sub-path needs a mount base.** The demo publishes at `/<repo>/`, so the router reads the mount point at import (`initialBase`) behind a flag only `demo.html` sets; the server build keeps `BASE = ""` and every existing `href` is unchanged.
