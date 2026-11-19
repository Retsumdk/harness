# Known defects

Every entry is a real limitation of the current build, written down rather than hidden. A defect
is listed only if someone could hit it. Severity uses the usual scale: **P0** data loss, auth
bypass or crash on the documented happy path; **P1** a brief requirement missing or broken;
**P2** a limitation a reasonable operator can live with, given the workaround.

**Open P0: none. Open P1: none.** The two P1s QA found in round 1 and the one it found in round 2
are fixed in this build (see *Fixed since round 1* and *Fixed since round 2* below). The P2s below ship.

---

### P2 — One access token for the whole instance
`HARNESS_TOKEN` is a single bearer credential. There are no user accounts, roles or per-agent
tokens, so anyone holding it can read every conversation, run any agent and enable any plugin.
*Workaround:* run one instance per person, or put the instance behind a reverse proxy that
terminates authentication. Multi-user accounts are out of scope for this build
(see `DELIVERY.md`, exclusions).

### P2 — The web client keeps the token in `localStorage`
The token is pasted once and stored client-side (`src/web/auth.tsx`), which is readable by any
script executing on the same origin. The app ships no inline third-party scripts and no `eval`,
so the practical exposure is a future XSS in the app itself.
*Workaround:* on a shared machine, use **Sign out** when finished; on a network you do not
control, prefer the CLI with `HARNESS_TOKEN` in the environment.

### P2 — No rate limiting on chat or agent runs
`POST /api/chat` and `POST /api/agents/:id/runs` accept as many concurrent requests as the
runtime will take. Memory is bounded per stream (`bin/perf-check.sh` measures 100 concurrent
streams), but nothing throttles a client that opens thousands.
*Workaround:* limit concurrency at the proxy, or keep the instance on a private network.

### P2 — Lists are unpaginated
Conversations, agent runs and the file listing return everything, in one response. Fine at the
hundreds; a workspace with tens of thousands of rows will send a large payload. File search stops
at the first 50 hits — a fixed cap, not a paging cursor.

### P2 — An interrupted run is closed at boot, not resumed
If the process dies mid-run, the next boot marks that run `failed` with the error string
`interrupted by a server restart` (`recoverInterruptedRuns` in `src/server/main.ts`, called from
`createHarness`). The step log up to the crash is kept, but the run is not restarted and its side
effects are not rolled back. *Workaround:* re-run the same input; agent runs are designed to be idempotent on the
workspace, but a half-written file stays half-written.

### P2 — The SQLite store has no migration path
Schema is created with `CREATE TABLE IF NOT EXISTS` at boot (`src/store/sqlite.ts`). A future
release that changes a column will not upgrade an existing database automatically.
*Workaround:* export conversations you care about before upgrading across a schema change.

### P2 — The shell is a command allowlist, not a syscall sandbox
`shell.run` executes only `echo`, `ls`, `cat`, `pwd` and `wc`, with no shell interpolation, a
5 s timeout, a 64 kB output cap, a scrubbed environment, and arguments that may not be absolute
paths or contain `..`. That is a fence, not a container: a permitted command still reads whatever
the process user can read through a path that is neither absolute nor dotted.
*Workaround:* run the server as a user with no access to anything but `HARNESS_HOME`. Kernel-level
isolation (containers, seccomp) is out of scope for this build.

### P2 — Webhook targets are checked by hostname, not by resolved address
The webhook plugin refuses loopback, private ranges, link-local and `.local` hosts before it sends
(`isPublicTarget` in `src/plugins/builtins/webhook.ts`). A public hostname that resolves to a
private address (DNS rebinding) is not defended against.

### P2 — Plugin handlers are code, manifests are data
A manifest can be installed over HTTP, but its tools only work if an implementation with that id
was registered at boot (`registerImplementation`). Loading third-party handler code from disk at
runtime is deliberately absent: it would mean executing unreviewed code inside the server.

### P2 — The static demo is the mock provider only
The hosted demo runs the real routes in the tab with the deterministic mock provider and no
`shell.run` (there is no process to run it in). It demonstrates behaviour, not model quality.

### P2 — the hosted demo keeps conversations but forgets files on reload
The in-tab kernel re-seeds its workspace on every page load (`writeSeedFiles` in
`src/demo/kernel.ts`), so a file a visitor creates or saves is gone after F5, while conversations,
runs, agents and settings persist in `localStorage`. This is a demonstration, not a store, but a
visitor who edits a file and reloads will reasonably think the save failed.
*Workaround:* treat the demo's workspace as sample data; the server build (`bun run start`) keeps
real files on disk. `DEMO.md` says so next to the run instructions.

### P2 — The client bundle has no minification-tuned budget
`bun run build:web` produces a ~272 kB JavaScript bundle (React + the app) and warns above
500 kB. Acceptable for a local-first tool; if it ever matters, the first lever is route-level
code splitting, which the single-bundle Vite config does not do today.

### P2 (fixed 2026-11-18) — Opening a file emptied the folder panel, and its "parent" breadcrumb did nothing
`src/web/pages/Files.tsx` used to keep the open file in local state while the address bar still
pointed at the folder, so the `← parent` link re-navigated to the page already on screen and issued
no request. The open item now lives in the URL (`filesHref` → `/files?path=<file>`), so the
breadcrumb always targets a different path than the one loaded, a reload or a pasted link reopens
the same file, and `← parent` returns the folder listing. The listing panel beside an open file is
still empty by design — the preview occupies that side. Covered by two tests in
`tests/web.views.test.tsx`.

### P2 — The seeded workspace README describes both storage modes (fixed 2026-11-18)
The `README.md` seeded into the workspace used to say "Everything here is plain files on disk … nothing
is stored in a database", which was true of the server build and false of the static demo, whose
workspace lives in memory and is re-seeded on every load. The seed copy now says the workspace is
plain files with no database behind it, and names both placements: a directory on disk on a server
install, held in the tab and re-seeded on every load in the browser demo, so a saved demo file does
not survive a refresh. Covered by a test in `tests/seed.test.ts` that asserts the seeded README
carries both statements.

### P2 — Files are text
The workspace API reads and writes UTF-8 text. Binary upload/download is not implemented; a
binary file dropped into `HARNESS_HOME/workspace` will list and fail to read cleanly.

### P2 — A stopped reply is stored as if it had finished
Pressing **Stop** while a reply is streaming aborts the stream, but the partial text is then saved
as an ordinary completed assistant message with no `interrupted` marker: `MockProvider.stream`
returns cleanly when the signal fires (`src/providers/mock.ts`, the `opts.signal?.aborted` return
inside the token loop), so `ChatService.send` falls through to its normal `addMessage({ role:
"assistant", … })` (`src/chat/service.ts`) with whatever text it had collected. Reproduced on the
public demo: a 10,000-character send stopped after about 1.2 s left a 1,549-character answer that
ended mid-sentence, indistinguishable from a complete one.
*Workaround:* treat a reply you stopped as a draft — edit or delete it — and do not read it as the
model's finished answer. Nothing is lost from the user's own message, which is stored before the
stream opens.

---

## Fixed in this build (found by review round 1)

Listed so the client can see what changed, not because anything is open. Both were reproduced in the
shipped static build, fixed, and are now held down by a test that fails without the fix.

### P1 — a file could not be saved or created in the static demo
`PUT /api/files` computed the stored size with `Buffer.byteLength`, which exists in Bun and not in a
browser tab, so every save and every new file came back as `internal error` in the demo
(`src/server/routes-workspace.ts`). The route now measures UTF-8 length with `TextEncoder`.
*Proven by:* `tests/demo.kernel.test.ts` — "files: save an existing file, create a new one, read both
back, delete" drives the route through the in-tab kernel, including multi-byte content.

### P1 — the live run view never left "running"
The run's SSE feed pulled once per read and returned without enqueuing when there were no new steps,
and nothing called it again, so a viewer opened mid-run never received the later steps or the `done`
event (`src/server/app.ts`, `GET /api/runs/:id/stream`). The feed is now driven by a timer that keeps
polling for the 60-second window and closes on `done`, on timeout or when the reader goes away.
*Proven by:* `tests/demo.kernel.test.ts` — "an agent run watched from mid-flight streams to done and
succeeded" opens the feed while the run is in flight and reads it to completion.
---

## Fixed since QA round 1

Both round-1 P1s were real, shipped in the bundle, and are fixed here with a test that fails without
the fix. Recorded rather than quietly removed, because the client's team may still have the old build.

### P1 (fixed) — `PUT /api/files` threw in a browser tab
`src/server/routes-workspace.ts` computed the response size with `Buffer.byteLength`, a Node/Bun
global that does not exist in a page, so every save and every new file in the static demo returned
`internal error`. Now `byteLength()` uses `TextEncoder`, which is identical on both runtimes.
Caught by `tests/demo.kernel.test.ts` → *files: save an existing file, create a new one…*, which
drives the route through the in-tab kernel and asserts a multi-byte size.

### P1 (fixed) — the live run view froze at "running"
`GET /api/runs/:id/stream` polled inside `pull()`. A pass that found no new steps returned without
enqueuing, and nothing re-invoked it, so a viewer opened mid-run never saw later steps or `done`
while the run itself finished in the store. The feed is now driven by a timer inside `start()`
(same shape as `POST /api/chat`), stops on abort, and closes on a 60 s deadline.
Caught by `tests/demo.kernel.test.ts` → *an agent run watched from mid-flight streams to done*, and
verified in a browser against the built bundle: badge `running` → step 1 → `succeeded`.

Two P2s from the same round are also fixed: the 409 recovery copy now names **Plugins → Capability
modules** (the screen that owns the control), and the home Files card reports a real file count with
copy that is true for the server and the in-tab kernel (`tests/web.views.test.tsx`).

---

## Fixed since round 1

### P1-1 — file save and new file returned "internal error" in the demo (fixed)
`PUT /api/files` sized its response with `Buffer.byteLength`, a Node/Bun global that does not
exist in a browser tab, so every save and every new file in the hosted demo threw. The route now
measures with `new TextEncoder().encode(content).length` (`src/server/routes-workspace.ts`).
*Caught by* `tests/demo.kernel.test.ts` → "nothing the browser runs reaches for Buffer or
process", which fails on the old line and names the file and line, plus "files: save an existing
file, create a new one, read both back, delete". Verified in a browser against the built bundle:
New file creates `notes/qa-round2.md`, and saving multi-byte content reports
`Saved notes/qa-round2.md`.

### P1-2 — the live run view froze at "running" (fixed)
`GET /api/runs/:id/stream` drove its feed from `pull()`. A `ReadableStream` only pulls again once
a read consumes a chunk, so a pass that found no new steps returned without enqueuing and was
never re-invoked: a viewer opened mid-run never received the later steps or the `done` event,
while the run itself finished correctly in the store. The route now runs a 100 ms timer from
`start()` and closes on the terminal status, the same shape as `POST /api/chat`.
*Caught by* `tests/demo.kernel.test.ts` → "an agent run watched from mid-flight streams to done
and succeeded", which waits until the store reports `running` and only then opens the feed the
way the run viewer does. Verified in a browser against the built bundle with the badge polled
every ~100 ms through a run: `running, 0 steps` → `running, 1 step` → `succeeded`, with the
Cancel button gone once the run ended.

### P2s closed in the same pass
- A stopped module's 409 now names the screen that has the control: "start it under Plugins →
  Capability modules" (`src/server/app.ts`).
- The workspace card on the home page reports a real file count from `GET /api/files` instead of
  a hardcoded `1`, and its copy is true for the server build and the in-tab demo alike.
- This document no longer claims there are no open P1s while P1s ship.
- The demo kernel is exercised on every route family that changes state: files save/create/delete,
  an agent run streamed to completion, plugin install → configure → enable → disable → uninstall,
  and a module stopped and restarted.

---

## Fixed before review round 2 (found by LEAD, not by QA)

### P1 (fixed) — a deep link or a reload landed on a blank page in the static demo
`scripts/finalize-demo.sh` copied `index.html` to `404.html`. The bundle references its assets
relatively (`./assets/demo-*.js`) so it can live under `/<repo>/`, but a host serves `404.html` at
*any* depth: `/<repo>/runs/run_123` resolved the script to `/<repo>/runs/assets/demo-*.js`, which
does not exist, so the document stayed `<div id="root"></div>` — a blank page. Reloading Files,
Agents or a run page hit exactly that. `src/demo/fallback.ts` now generates `404.html`: it probes
`/<first-segment>/assets/<entry>.js` then `/assets/<entry>.js`, publishes the hit as `<base>` (so
the router's own mount point matches), injects the CSS and the module absolutely, and if neither
candidate holds the bundle it prints "This address is not part of the demo" with a link home
instead of going blank. `finalize-demo.sh` refuses to finish if `404.html` still carries a relative
asset path. Proven in a browser against the shipped bundle: `…/harness-demo/runs/run_a6bd20e8fc054793`
renders the run page (`succeeded`, steps listed) on a cold load, `…/files` renders after a reload,
and `…/agents/deep/nonsense` renders the app's own 404 route with its way back.

### P2 (fixed) — the Files page claimed files were "on disk" inside the demo
The subtitle read "Plain files on disk" in both kernels; the static demo keeps them in the tab.
It now says "Plain files: browse, edit and search the same workspace agents work in", and
`tests/web.views.test.tsx` fails if the phrase comes back.

### P2 (fixed) — the Files page ignored `?path=`, so its own breadcrumb sent you to the root
Every `FilesPage` mount loaded `.` (`src/web/pages/Files.tsx`), which nothing noticed while the
only folders were one deep: the `← parent` link resolved to the root by coincidence. A folder two
levels down, a reload inside a folder and any shared `/files?path=…` URL all landed at the root.
The folder now comes from the URL (`pathFromSearch`), so a reload, a breadcrumb click and a deep
link agree. Covered by two tests in `tests/web.views.test.tsx`.


## How a defect gets here

A defect is added when a test would have caught it and did not, or when a limitation is a
deliberate scope decision that a client could trip over. Each entry names the file that owns the
behaviour, so the next person reads the code rather than the prose. When one is fixed, delete the
entry in the same commit that fixes it — a stale defect list is worse than none.
