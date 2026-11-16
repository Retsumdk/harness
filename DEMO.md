# Running HARNESS

Three commands, from a clean checkout:

```bash
bun install
bun run build:web
HARNESS_TOKEN=dev-token bun run start
```

Then open <http://localhost:8787> and paste `dev-token` as the access token.
The first boot creates `.harness/` (SQLite database + workspace) and seeds it:
two agents, one conversation, three files, and two finished runs.

No API keys are needed. The `mock` provider ships with the build: it echoes your
message, and a message of the form `/tool fs.list {}` makes it call a real
workspace tool so you can watch the tool loop in the UI.

## What to click first

1. **Chat** — open "Workspace tour", send `/tool fs.list {}`. You get a tool call,
   its result, and the model's summary, streamed.
2. **Agents** — run *Research Assistant* on `/tool fs.search {"q": "Plugins"}` and
   watch the run page fill in step by step.
3. **Files** — open `data/releases.csv`, edit, save.
4. **Plugins** — the GitHub and Webhook built-ins are listed and inert until
   their required config is filled in.
5. **Plugins → Capability modules** — the switchboard at the bottom of the page: stop `chat` and the
   chat route answers `409` until you start it again.
6. **Settings** — default provider and model.

## The static demo (same app, no server)

The public demo is the same client and the same routes, with the kernel running
inside the tab: a mock model, an in-memory workspace, and localStorage for the
agents and conversations.

```bash
bun install
bun run build:demo
python3 -m http.server 8123 --directory .
# then open http://localhost:8123/demo/
```

It is a static bundle: `demo/index.html` plus `demo/assets/`, relative paths, so
it runs from a sub-path such as `https://<user>.github.io/<repo>/`. Only the
`mock` provider exists there, and `shell.run` is absent — the shell needs a
process, and the demo deliberately has none. Everything else behaves as it does
on the server: chat streams, tools read the seeded files, agents run step by step,
plugins enable and disable.
One difference is deliberate and worth knowing before you click: **files do not survive a reload.**
Conversations, runs, agents and settings are kept in the browser's `localStorage`, but the workspace
is re-seeded from sample data on every page load, so a file you create or edit in the demo is gone
after F5. The server build above keeps real files on disk.

## Same thing over HTTP

```bash
curl -s localhost:8787/health
curl -s -H "authorization: Bearer dev-token" localhost:8787/api/agents
```

## Proving it works without a browser

```bash
bun run smoke
```

Builds nothing itself, boots the app on a throwaway home, and checks the served
bundle, the SPA fallback, auth, seed data, a streaming chat with a tool call, an
agent run to completion, plugins, modules, settings and the path-escape guard.
It prints `RESULT: PASS` or a list of failures.

## The performance gate

```bash
bash bin/perf-check.sh      # or: bun run perf
```

Spawns the real server three times and times boot to a `200` on `/health`, then opens 100
concurrent SSE chats and measures wall time, RSS growth and that every conversation was
persisted. Prints `RESULT: PASS` with the numbers, or the check that failed.

## When it does not start

| Symptom | Cause | Fix |
|---|---|---|
| `HARNESS_TOKEN is not set` | no token in the environment | `cp .env.example .env`, set the token, or prefix the command with `HARNESS_TOKEN=...` |
| `EADDRINUSE` on 8787 | another process owns the port | `HARNESS_PORT=8788 bun run start` |
| The page says the web client has not been built | `dist/web/index.html` is missing | `bun run build:web` |
| The UI answers `unauthorized` | the pasted token differs from the server's `HARNESS_TOKEN` | Sign out and paste the value the server was started with — they must match exactly |
| A deep link 404s on a static host | the host has no SPA fallback | serve the `demo/` output from `bun run build:demo`; it ships a `404.html` that boots the app |
