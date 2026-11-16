# HARNESS

A self-hosted AI workspace: chat with a model, work on files, run tools, build agents that
run unattended, and switch integrations on and off — all from one Bun process, with one HTTP
API and one CLI over the same code.

It is deliberately small. No accounts, no billing, no hosted infrastructure: a single
bearer token, a SQLite file, a workspace directory, and a React client served by the same
server that answers the API.

---

## Run it

```bash
bun install
bun run build:web
HARNESS_TOKEN=dev-token bun run start
```

Open <http://localhost:8787> and paste `dev-token`. The first boot creates `.harness/`
(SQLite database + workspace) and seeds it — two agents, one conversation, three files, two
finished runs — so the app is understandable from the first screen instead of empty.

No model keys are needed. The `mock` provider ships with the build; send it
`/tool fs.list {}` and it calls a real workspace tool so you can watch the tool loop work.
Point `OPENAI_BASE_URL`, `OPENAI_API_KEY` and `OPENAI_MODEL` at any OpenAI-compatible
endpoint to use a real model (see `.env.example`).

Requirements: Bun 1.1 or newer (built and tested on 1.4). Nothing else — SQLite is
`bun:sqlite`, the server is Hono, the client is React built by Vite.

---

## What you can do with it

| Surface | What it does |
|---|---|
| **Chat** | Streaming replies over SSE, persisted history, provider and model picker, and a tool loop: the model can call workspace tools, see the results, and answer from them. |
| **Files** | Browse, read, edit, create, search and delete files in the workspace. Paths are confined to the workspace root; `..` and absolute paths are refused server-side. |
| **Agents** | Persisted definitions (name, system prompt, provider/model, tool allowlist, step and token budgets). A run is a loop of plan → tool call → observe → finish, visible step by step as it happens, cancellable, and replayable. Agents can spawn child agents, capped at depth 3. |
| **Runs** | Every run is stored with its steps, tool arguments, tool results, token usage and final status. `running`, `succeeded`, `failed`, `cancelled`, `budget_exceeded`. A run a crash left behind is closed at the next boot instead of spinning forever. |
| **Plugins** | Integrations as declarative manifests: permissions, a typed config schema, namespaced tools. Enable, configure, disable and uninstall at runtime; a disabled plugin's tools are withdrawn from the registry immediately. Built-ins: **GitHub** (repo metadata, open issues) and **Webhook** (signed JSON POST to a public endpoint). |
| **Modules** | The app itself is a set of modules (`core`, `fs`, `tools`, `providers`, `chat`, `agents`, `plugins`). Stop one and its routes answer `409` instead of pretending to work; a module that would strand a dependant is refused. |
| **CLI** | `harness chat`, `run-agent`, `ls`, `files cat\|write\|rm\|search`, `agents`, `plugins`, `health` — a thin client of the same HTTP API, so what you can click you can also script. |

Screens: home dashboard, chat, files, agents, run viewer, plugins and module switchboard,
settings, and a 404 route with a way back. Every panel has hand-written empty, loading and
error states.

---

## Architecture

```
src/
├── core/       module registry (dependency order, cycles, in_use), event bus, lifecycle
├── store/      Store interface: SQLite for the server, in-memory for tests
├── providers/  Provider interface: mock (always present), OpenAI-compatible
├── chat/       conversations, streaming, tool-call routing, loop limits
├── tools/      registry with JSON-schema argument validation; fs.*, shell.run
├── fs/         WorkspaceLike contract: disk (server) or memory (demo), path confinement
├── agents/     definitions, runner loop, budgets, child spawn, run log, cancel
├── plugins/    manifest validation, lifecycle, secret masking; github + webhook
├── server/     Hono routes, SSE, bearer auth, static client, seed data
├── web/        React client — one router, one token sheet, views + containers
├── cli/        argv parsing, exit codes and stream rendering over the HTTP API
└── demo/       the same app assembled in the browser over in-memory storage
```

Two design decisions worth knowing:

**The tool registry is the integration point.** Built-in tools, plugin tools and module
tools are all `{name, description, schema, run}` in one registry. An agent's allowlist is
checked at run time, not at creation time, so revoking a plugin revokes it for every agent.

**The demo runs the app, not a mock of it.** `src/demo/` assembles the same `createApp`, the
same routes, the same chat service and agent runner, over an in-memory workspace and a
localStorage store. Only two things differ there: the model is `mock`, and `shell.run` is
absent because a browser tab has no process to run it in.

---

## HTTP API

Every `/api/*` route needs `Authorization: Bearer $HARNESS_TOKEN`. `/health` does not.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | version, ok, module states |
| `POST` | `/api/chat` | one turn; SSE events `token`, `tool_call`, `tool_result`, `done` |
| `GET` | `/api/conversations` | list conversations |
| `GET`/`DELETE` | `/api/conversations/:id` | messages, or delete |
| `GET` | `/api/files?path=` | list a directory, or return a file |
| `GET` | `/api/files/search?q=` | search workspace text (first 50 hits) |
| `PUT`/`DELETE` | `/api/files` | write or delete a file |
| `GET`/`POST` | `/api/agents` | list or create definitions |
| `GET`/`PUT`/`DELETE` | `/api/agents/:id` | read, update, delete |
| `POST` | `/api/agents/:id/runs` | start a run → `{runId}` |
| `GET` | `/api/runs`, `/api/runs/:id` | list runs, read one with its steps |
| `GET` | `/api/runs/:id/stream` | live SSE for a run |
| `POST` | `/api/runs/:id/cancel` | cooperative cancel |
| `GET`/`POST` | `/api/plugins` | list, or install a manifest |
| `POST` | `/api/plugins/:id/enable`, `/disable` | toggle; tools follow |
| `PUT` | `/api/plugins/:id/config` | merge config, validated against the manifest |
| `DELETE` | `/api/plugins/:id` | uninstall (disable first) |
| `GET` | `/api/modules` | states, dependants, missing dependencies |
| `POST` | `/api/modules/:id/enable`, `/disable` | switchboard |
| `GET`/`PUT` | `/api/settings` | default provider and model |

Errors are always `{"error": {"code", "message"}}` with `400` bad input, `401` auth, `404`
unknown, and `409` for a stopped module or a conflicting resource.

```bash
curl -s localhost:8787/health
curl -s -H "authorization: Bearer dev-token" localhost:8787/api/agents
```

---

## CLI

```bash
bun run cli health
bun run cli chat "summarise data/releases.csv"           # streams, prints tool calls
bun run cli run-agent "Research Assistant" '/tool fs.search {"q": "onboarding"}'
bun run cli files write notes/todo.md --content "ship it"
bun run cli plugins --enable webhook
```

`HARNESS_TOKEN` and `HARNESS_URL` (default `http://localhost:8787`) are read from the
environment; `--token`, `--base` and `--json` override per call. Exit codes: `0` done, `1`
the server refused or could not be reached, `2` your command was wrong.

---

## Testing and gates

```bash
bun run typecheck   # tsc --noEmit, strict
bun test            # unit + integration across the whole tree
bun run coverage    # bun test --coverage, gate is 80%
bun run smoke       # boots the real server on a throwaway home and drives the API
bun run perf        # cold start < 1s, 100 concurrent chats bounded
bun run check       # all of the above, in order
```

The smoke test is the one that matters before a release: it builds nothing itself, boots the
app on a temporary home, and checks the served client, the SPA fallback, auth rejection, the
seed data, a streaming chat with a tool call, an agent run to completion, plugins, modules,
settings and the path-escape guard. It prints `RESULT: PASS` or the list of failures.

The perf gate spawns the real server and measures spawn → `/health` answering, then opens
100 concurrent SSE chats and checks that all of them finish and memory stays under a ceiling.
Current numbers are printed on every run; see `KNOWN-DEFECTS.md` for what is known not to
hold at larger scale.

---

## Running it for real

- **Data lives in `HARNESS_HOME`** (default `./.harness`): `harness.db` plus `workspace/`.
  Back that directory up; everything else is reproducible from the repo.
- **Bind behind a TLS terminator.** The server speaks plain HTTP and trusts its bearer token;
  put it behind your proxy of choice and do not expose port 8787 to the internet directly.
- **One token, one person.** There are no users or roles. Treat the token as the password to
  the machine — see `KNOWN-DEFECTS.md` before giving it to more than one person.
- **Restarting is safe.** SQLite is in WAL mode, runs interrupted by a restart are marked
  `failed` at the next boot rather than left `running`.

---

## Docs

| File | What is in it |
|---|---|
| `docs/EXTENDING.md` | Add a tool, a plugin (with the permission reference) or a module; the contracts and the rules each one must keep. |
| `KNOWN-DEFECTS.md` | What is known to be wrong or missing, with severity and workaround. Read this before trusting the app with anything that matters. |
| `DEMO.md` | The three commands to run it, what to click first, and the static in-browser build. |
| `.env.example` | Every environment variable, with defaults. |

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `HARNESS_TOKEN is not set` and exit 1 | Start with `HARNESS_TOKEN=... bun run start`, or copy `.env.example` to `.env`. The server will not boot unauthenticated by design. |
| Page says "the web client has not been built yet" | The API is up, `dist/web` is missing. `bun run build:web` then reload. |
| Every request answers `401` | The token the client stored is not the token the server started with. Sign out and paste the right one. |
| `EADDRINUSE` on start | Something else has 8787. `HARNESS_PORT=8788 bun run start`. |
| A route answers `409 module_disabled` | That module was stopped in the switchboard at the bottom of the **Plugins** page. Start it again there. |
| Plugin says "configure required field(s) first" | Fill the fields on the plugin card and save; a plugin with a required secret cannot be enabled before it is configured. |
| Agent run stops with `budget_exceeded` | The run hit its step or token cap. Raise the budgets on the agent definition. |
