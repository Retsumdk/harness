# Delivery — HARNESS

**Job:** JOB-MWE35OL3-ZH8TJ · **Client:** Commissioner · **Delivered:** 2026-11-16
**Reviewed by:** independent QA, review round 3, verdict **PASS**, 95/100, 0 open P0/P1.

## The two artifacts

| | |
|---|---|
| **Source (public)** | https://github.com/Retsumdk/harness — visibility `PUBLIC` |
| **Live demo (public, no sign-up)** | https://retsumdk.github.io/harness-demo/ |

The demo is the real client bundle, built from the same commit as the repo. It runs against
an in-memory workspace on purpose, so anyone can click through it without a server. Two
consequences, both expected: it only has the `mock` model provider (no API keys on a public
page), and files you create there are gone after a reload — conversations and runs survive.

## Run it yourself — three commands

From a clean clone of the repo, with Bun 1.1+ installed and nothing else:

```bash
bun install
bun run build:web
HARNESS_TOKEN=dev-token bun run start
```

Open <http://localhost:8787> and paste `dev-token` as the access token. First boot creates
`.harness/` (a SQLite file plus the workspace directory) and seeds it with two agents, one
conversation, three files and two finished runs, so the app is legible on the first screen.

No model key is required to start: the `mock` provider ships with the build. Send it
`/tool fs.list {}` in chat and it calls a real workspace tool, so you can watch the tool loop
end to end. To use a real model, point the three provider variables at any OpenAI-compatible
endpoint (see `.env.example`, which is complete and whose defaults boot).

## Configuration

Copy `.env.example` to `.env`. Every value has a working default except the first:

| Variable | Meaning |
|---|---|
| `HARNESS_TOKEN` | **Required.** The single bearer credential for the API, the CLI and the web client. The server refuses to boot without it because this app writes files and runs commands. |
| `HARNESS_PORT` | HTTP port, default `8787`. |
| `HARNESS_HOME` | Where the SQLite database and the workspace live, default `.harness`. |
| `HARNESS_WEB_DIST` | Built client location, default `dist/web` (`bun run build:web`). |
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` | Optional. Adds an `openai-compat` provider; unset, only `mock` is offered. |

## What was asked for, and where it is

Every requirement in the brief is implemented and marked met in the QA review, with a
verification recorded for each:

| | Requirement | How it is met |
|---|---|---|
| R1 | An AI-native computer: files, tools, chat, apps | One process serves `/`, `/chat`, `/files`, `/agents`, `/plugins`, `/settings`; the home screen prints live counts that move when the workspace changes. |
| R2 | UI, HTTP API and CLI over the same capabilities | Same server, same data, three clients — `harness health`, `harness ls`, `harness agents` and `curl` all read the same state the UI shows. |
| R3 | AI chat with streaming, history, providers | SSE streaming with inline tool calls, persisted conversations, provider/model picker; empty composer keeps Send disabled. |
| R4 | Integrations | A plugin system with manifests: built-in GitHub and Webhook plugins declare their tools, permissions and required config, stay inert until configured, and treat secrets as write-only. |
| R5 | A modular environment | Seven capability modules with declared dependency edges, individually startable and stoppable from Plugins → Capability modules; `docs/EXTENDING.md` documents the extension contract. |
| R6 | Spawn functional AI agents | Agent definitions with a tool allowlist and step/token budgets; runs stream live, record each step with its tool call and result, and are replayable from `/runs/<id>`. |
| R7 | Swift and efficient | `bun run perf` — cold start ~50 ms, 100 concurrent chats with 0 failures, ~+16 MB RSS, 100 conversations persisted. |
| R8 | Thorough, complete, refined | 269 tests / 0 failures across 25 files, 83.3 % function / 87.5 % line coverage, a smoke run, a perf run and an 18-check e2e pass, plus hand-written empty, loading and error states on every panel. |

## What is deliberately excluded

Decided while building, stated here rather than left to be found:

- **No user accounts, roles or per-agent tokens.** One bearer token for the instance. Run one
  instance per person, or terminate authentication at a reverse proxy.
- **No third-party OAuth apps.** The plugin contract is the extension point; shipping OAuth
  client flows for individual services is out of scope for this build.
- **No binary file transfer.** The workspace API reads and writes UTF-8 text.
- **No rate limiting, no pagination, no store migrations.** Correct at the scale this is built
  for (one operator, hundreds of rows); all three are listed as P2s so nobody is surprised later.
- **The demo is the client-side build on a static host.** Anything that needs the server — real
  files on disk, real model providers, the CLI — runs from your clone, not from the public page.

## Known limitations you are shipping with

`KNOWN-DEFECTS.md` in the repo is the full list: 14 open P2 entries, no P0 and no P1. Three of
them came out of the final review round — two are fixed, and one ships open because it is a
limitation you can work around rather than a broken requirement:

- The Files "← parent" breadcrumb used to re-open the page you were already on, so it did nothing;
  the open file now lives in the URL and the link returns its folder (fixed 2026-11-18). The panel
  beside an open file still lists no entries, by design.
- The seeded workspace `README.md` used to describe every file as "on disk", which was false in the
  public demo's in-memory workspace; it now names both storage modes and says a file saved in the
  demo does not survive a refresh (fixed 2026-11-18).
- Still open: **pressing Stop mid-reply saves the partial text as a finished assistant message**,
  with no marker that it was interrupted, so a stopped answer can look complete. It is listed in
  `KNOWN-DEFECTS.md` with its workaround — edit or delete a reply you stopped rather than reading it
  as final. The brief does not describe Stop, and this delivery is frozen at the commit QA reviewed,
  so the entry documents the behaviour instead of changing it.

## How this was verified

- Clean clone of the repo: `bun install --frozen-lockfile` → `bunx tsc --noEmit` →
  `bun test --coverage` (269 pass, 0 fail) → `bun run build:web` → `bun run build:demo` →
  `bun run smoke` → `bun run e2e` → `bun run perf`. All green, twice: once by the engineer and
  once by the independent reviewer.
- CI (GitHub Actions) green on the pushed commit.
- The public demo was driven in a browser from a cold load: home counts, a chat with a live tool
  call, a file save, an agent run reaching `succeeded`, a deep link to `/files`, and the 404
  route — no console errors.
- An end-to-end acceptance check on the delivery itself: the repo is public as declared, a cold clone
  installs and builds, the suite is green, and the live demo answers with no error page.

## Reporting a bug

Open an issue on https://github.com/Retsumdk/harness with the screen, the click that caused it,
and what you expected. `KNOWN-DEFECTS.md` lists what is already known — if it is not there, it
is new and worth reporting.
