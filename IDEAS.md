# Ideas for Vibe Coders

High-leverage additions beyond the current Services / Logs / Git / Agent dashboard.

> **Conventions** (so each idea slots into the existing patterns):
> - **Server routing** is a manual `routeRequest()` in `src/web/server.ts` — add an `if (request.method === ... && url.pathname === ...)` block per endpoint.
> - **Core logic** is a stateful module in `src/core/` (Zod-validated), exposed to the web layer and mirrored as an MCP tool in `src/mcp/tools.ts` where it makes sense.
> - **UI** is a feature folder under `src/web/client/src/features/`, surfaced as a tab in `app.tsx` or a panel in an existing view.
> - Keep Git **read-safe** and DB/API access **read-only** unless the idea explicitly calls out a guarded write.

## 1. Env/Secrets Manager — ✅ shipped (ROR-10)
View and edit `.env` files per service in one place, with masking. Done: `.env*` key/value table, secret masking, comment-preserving writes (`src/core/env-file.ts` + `config-files.ts`). Remaining bonus: "inject into running process" so they don't restart-and-pray.

## 2. Error Inbox (killer feature) — ✅ shipped (ROR-14)
Auto-tail logs across all services. Surface stack traces / `ERROR` lines into a single feed. Each entry has a **"Copy to agent"** button that builds a prompt with the stack trace, recent diff in the affected file, and last N log lines for context. Turns "I have a bug" → one click → ready-to-paste prompt.

Done as a vertical slice:
- **Core** — `src/core/error-inbox.ts`: subscribes via the new `LogStore.subscribe()` emitter, runs detectors (error/exception headers, `WARN`, Node `at …`, Python `Traceback` + `File "…", line N`, Java `Exception in thread`), dedupes by normalized signature into a ring buffer of incidents, and looks back through context lines to attach the top `path:line` frame (resolved against the service `cwd`).
- **API** — `src/web/routes/errors-routes.ts`: `GET /api/errors`, `GET /api/errors/stream` (SSE), `GET /api/errors/:id/prompt` (excerpt + `GitManager.diff()` + last 40 log lines). Registered in `routes/index.ts`.
- **UI** — `features/errors/` (`error-inbox-view` + `incident-detail` + `use-error-incidents` hook) behind a new **Error Inbox** sidebar tab; live SSE feed, master/detail, clipboard **Copy to agent**.
- **MCP** — `src/mcp/tools/errors.ts`: `nomoreide_list_errors` + `nomoreide_error_prompt` (the "send to MCP" variant).
- **Reuses** — `LogStore` ring buffer + new subscribe, `GitManager.diff`, the SSE pattern from `/api/agent/tool-calls/stream`.

Remaining bonus (now unblocked): #7 test-runner pipeline and #8 repro bundle both build on these incidents.

## 3. HTTP Request Inspector — ✅ shipped (ROR-6)
Proxy on the service port that records requests/responses; replay, share, or pipe to an agent without Postman/Charles. Core in `src/core/http-inspector.ts` + `POST /api/services/:name/inspector`; the UI panel landed as `features/services/service-detail/http-tab.tsx` (request timeline, body view, replay).

## 4. DB Peek — ✅ shipped
Lightweight read-only table browser. "Explain this row to the agent" copies the row + schema into a prompt.

Shipped all three engines at once (not just Postgres) as a standalone **Database** tab — connections live independently of services, with `.env` auto-detect for one-click setup. SQLite uses Node's built-in `node:sqlite` (no native build), so `engines.node` was bumped to `>=22.5`.

Done as a vertical slice:
- **Config** — `databases: { name, engine, url }[]` added to the config schema (`config-store.ts` + `registerDatabase`/`removeDatabase`). For SQLite, `url` is the `.db` file path; for Postgres/MySQL it's the connection string, masked in API responses via `maskConnectionUrl`.
- **Core** — `src/core/db-peek.ts` (manager: driver cache, env-detection, masking) + `src/core/db/` drivers: `postgres-driver.ts` (`pg`, `BEGIN TRANSACTION READ ONLY`), `mysql-driver.ts` (`mysql2`, `START TRANSACTION READ ONLY`), `sqlite-driver.ts` (`node:sqlite`, opened `readOnly`). Each exposes `listTables`/`sampleRows`/`testConnection`. **No raw SQL** — `sampleRows` only browses tables resolved against the live catalog (identifier-injection guard), `SELECT *` with parameterized `LIMIT`.
- **API** — `src/web/routes/database-routes.ts`: `GET /api/databases`, `GET /api/databases/detect` (scan service `.env` for DB URLs), `POST /api/databases`, `POST /api/databases/test`, `DELETE /api/databases/:name`, `GET /api/databases/:name/tables`, `GET /api/databases/:name/rows?table=&limit=`.
- **UI** — `features/database/` (`database-view` master/detail + `use-databases` hooks + `add-connection-dialog` with env-detect chips / paste / engine form + `table-grid` with per-row "Explain to agent") behind a new **Database** sidebar tab.
- **MCP** — `src/mcp/tools/database.ts`: `nomoreide_list_databases`, `nomoreide_db_tables`, `nomoreide_db_sample` (read-only, scoped to configured connections).
- **Reuses** — env-file parsing for `.env` detection; the master/detail layout from Error Inbox; `ComposerDialog`.

## 5. PR Cockpit — ✅ shipped
GitHub PR + CI checks for the current branch in one panel: PR state (open/draft/merged), CI status, review state, one-click "copy failing check output to agent".

Shipped as a standalone **GitHub** view — `core/github-manager.ts` + `web/routes/github-routes.ts` + MCP `mcp/tools/github.ts` (PR/issue lists, CI badges, actions/workflow runs, create/merge PR, issue comments) + `features/github/` (PR/issue detail, branches, actions). Token via `nomoreide_github_set_token` / `gh` CLI fallback. Markdown rendering + comment composer were being polished as of ROR-40.

*Original GitHub-first plan for reference:*

**GitHub-first.** Most users live on GitHub, so ship that as the MVP. The app reaches GitHub with its own credential — **reuse the local `gh` CLI** if present (zero-config: `gh pr view --json ...`, `gh pr checks`), fall back to a token in config.

**Build:**
- **Core** — `src/core/github.ts`: detect `gh` on PATH; `getPrForBranch(branch)` → `gh pr view <branch> --json number,state,isDraft,reviewDecision,statusCheckRollup`; `getFailingCheckLogs(pr)` → `gh run view --log-failed`. Branch comes from `GitManager`.
- **API** — `GET /api/pr/current` (PR + checks for the active branch), `GET /api/pr/current/failing-logs/prompt` (failing check output → agent payload). Gracefully return `{ available: false }` when `gh` is absent/unauthed so the UI can show a setup hint.
- **UI** — `features/git/pr-cockpit.tsx` as a panel inside the existing Git view; status pills for PR + each check, "copy failing logs to agent".
- **Reuses** — `GitManager` for the current branch; same SSE/poll pattern for live check status.

*Later, opt-in:* Linear issue context for the branch. The app has **no Linear integration today** (only the agent's MCP does), so this needs the app to store its own Linear API token first. Until then, the branch name already encodes the issue ID — deep-link to linear.app without pulling data live.

## 6. Snapshot / Restore — ✅ shipped (ROR-39)
Git stash-like checkpoints tied to "before agent edit". One-click revert when an AI change goes sideways — no `git reflog` puzzle.

Shipped with #11 as one slice: `core/snapshot-manager.ts` (temp `GIT_INDEX_FILE`, private `refs/nomoreide/snapshots/*`, reversible restore that also deletes post-snapshot additions) + `core/agent-sessions.ts` (auto-snapshots before a session's first tool call) + `routes/snapshot-routes.ts` + read-only MCP `nomoreide_snapshots_list`/`nomoreide_snapshot_create` (no restore tool — human-only) + Git→Snapshots tab.

*Original design for reference:*

**Design risk:** restore is a destructive write, but `GitManager` is deliberately read-safe (no `reset --hard`/`clean`/`force-push`). Resolve by always snapshotting the current state *before* a restore, so the undo is itself reversible.

**Build:**
- **Core** — new `src/core/snapshot-manager.ts` (kept *separate* from the read-safe `GitManager`, with its writes confined to private refs):
  - `snapshot(label)` → capture working tree without touching HEAD/branches: `git add -A && git write-tree`, then `git commit-tree` parented on HEAD, store the resulting sha under `refs/nomoreide/snapshots/<ts>-<label>`. Never moves the user's branch.
  - `list()` → enumerate that ref namespace `{ sha, label, createdAt, fileCount }`.
  - `restore(sha)` → **first** call `snapshot("pre-restore")`, then `git checkout <sha> -- .` to repopulate the working tree (avoids `reset --hard`).
- **API** — `GET /api/snapshots`, `POST /api/snapshots` `{label}`, `POST /api/snapshots/:sha/restore`.
- **UI** — snapshot list + "Restore" in the Git view; a manual **"Snapshot now"** button is the MVP, auto-snapshot-on-agent-activity (hook into `ToolCallStore`) is phase 2.
- **Pairs with #11** — a snapshot is the natural boundary of an agent change-set.

---

# More ideas

## 7. Test Runner → Error Inbox pipeline — ✅ shipped (ROR-15)
Run `npm test` (or a single file) from the UI; pipe failures into the Error Inbox (#2) with a "copy to agent" prompt.

**Build:**
- **Core** — `src/core/test-runner.ts`: spawn the configured test command (per-service `test` field, default `npm test`) via the same child-process plumbing as `service-tester.ts`; stream stdout/stderr into `LogStore` under a synthetic `<service>:test` channel; on non-zero exit, parse failures (Vitest/Jest summary lines, `FAIL <file>`) into Error Inbox incidents.
- **API** — `POST /api/services/:name/test` `{ pattern? }` (mirror the existing `POST /api/services/test`), `GET /api/services/:name/test/stream` (SSE of output).
- **UI** — a "Tests" sub-tab in `service-detail-panel.tsx`: run button, live output, failures linking into the Error Inbox.
- **Reuses** — `service-tester.ts` pattern, `LogStore`, `error-inbox` detectors from #2.

## 8. "Share my bug" reproduction bundle — ✅ shipped (ROR-16)
Extension of #2: package failing logs + diff in the affected file + service state + masked env into one shareable artifact (clipboard prompt or a `.md` file).

**Build:**
- **Core** — `src/core/repro-bundle.ts`: given an Error Inbox incident id, assemble `{ incident, fileDiff (GitManager.diff), recentLogs (LogStore), serviceState (ProcessManager status), env (masked via env-file masking) }` and render to markdown.
- **API** — `GET /api/errors/:id/bundle` (returns markdown) — extends #2's prompt endpoint with the extra context.
- **UI** — a "Copy repro bundle" button next to "Copy to agent" on each Error Inbox entry; optional "save to `.nomoreide/repros/`".
- **Reuses** — everything from #2 plus `ProcessManager` status and env masking. Build right after #2.

## 9. Service dependency / startup order — 📋 OPEN (next candidate)
Declare "API depends on DB", auto-start in order, show a health graph. *Confirmed unbuilt: no `dependsOn` in the service schema as of 2026-06-13.* Cleanest standalone win of the leftovers — all the pieces (bundles, `ProcessManager`, `service-health.ts`, `process-tree.ts`) already exist.

**Build:**
- **Config** — add `dependsOn?: string[]` to the service schema in `config-store.ts`.
- **Core** — in `process-manager.ts`, topologically sort on `dependsOn` before a bundle start; wait for each dependency's health probe (`service-health.ts`) to pass before starting dependents; detect cycles and surface a clear error.
- **API** — bundle start already exists; extend its response with resolved order + per-node status.
- **UI** — a small dependency/health graph in the Services view (reuse the SVG approach from `git-graph-svg.tsx`).
- **Reuses** — bundles, `ProcessManager`, `service-health.ts`.

## 10. Resource usage per service — ✅ shipped
Mini-`htop`: CPU/memory per managed process. Shipped as `core/metrics-store.ts` + `web/routes/metrics-routes.ts` (CPU/RSS polling over the process tree with rolling history).

**Build:**
- **Core** — `src/core/resource-monitor.ts`: poll CPU/RSS for each spawned PID (and children — `process-tree.ts` already walks the tree) on an interval; keep a short rolling history per service.
- **API** — `GET /api/services/:name/resources` (current + sparkline history), or fold into the existing `/api/status` payload.
- **UI** — CPU/mem chips + a tiny sparkline in `service-list.tsx` / `service-detail-panel.tsx`.
- **Reuses** — PIDs from `ProcessManager`, `process-tree.ts` for child aggregation. (Cross-platform sampling is the only real work — consider `pidusage`.)

## 11. Agent change-set — "what did the AI touch this session" — ✅ shipped (ROR-39)
Group file edits by agent session and show them as a reviewable set. AI-native differentiator. Shipped alongside #6: change-sets are `git diff <session-snapshot>` (NoMoreIDE's MCP never sees the agent's Edit/Write calls) surfaced in an Agent→Changes tab.

**Build:**
- **Core** — extend `tool-call-store.ts`: `ToolCallRecord` already captures tool calls; tag each with a `sessionId` and, for file-writing tools (Edit/Write), record the touched path. Add `changeSetForSession(id)` → list of files + which tool/when.
- **API** — `GET /api/agent/change-sets` (sessions with file counts), `GET /api/agent/change-sets/:id` (files + per-file diff via `GitManager.diff`).
- **UI** — a "Changes" sub-tab in `agent-view.tsx`: session list → file list → diff, with a "Restore to before this session" button wired to #6.
- **Reuses** — `ToolCallStore` + its SSE stream, `GitManager.diff`, snapshot refs from #6.

## 12. Agent cost / run history — 📋 OPEN
Persist token usage over time so you can see "this feature cost ~$X / N agent runs." *Confirmed unbuilt: live usage renders in `usage-card.tsx`, but there is no `core/usage-history.ts` and no `/api/agent/usage/history` route as of 2026-06-13.*

**Build:**
- **Core** — `usage-info.ts` already reads live Claude + Codex token/rate-limit data (`buildUsageInfo`). Add `src/core/usage-history.ts`: snapshot `UsageInfo` deltas to an append-only file at `.nomoreide/usage-history.jsonl` (timestamp, model, tokens, est. cost). Apply a simple per-model price table to estimate `$`.
- **API** — `GET /api/agent/usage/history?since=` (time series), aggregate by day/session.
- **UI** — a "Usage" sub-tab in `agent-view.tsx`: cumulative tokens + estimated cost chart; optionally attribute to the active git branch (tie-in with #11's `sessionId`).
- **Reuses** — `usage-info.ts`, the Agent tab, the append-to-`.nomoreide/` logging pattern from `LogStore`.

## 14. Web Terminal (multi-tab) — ✅ shipped
A real terminal inside the dashboard — full `node-pty` shells over WebSocket, with VS Code-style tabs (add / switch / close).

Done as a vertical slice:
- **Core** — `src/core/terminal-session.ts` wraps one PTY (start/write/resize/restart/stop + output/state subscriptions, injectable adapter for tests). `src/core/terminal-manager.ts` (`TerminalSessionManager`) owns a `Map<id, TerminalSession>` so several tabs run at once: `list/create/get/ensure/close/disposeAll`.
- **Server** — a single `ws` upgrade on `/api/terminal/socket?id=` routes each socket to its session (lazily spawned via `ensure`); closing a socket leaves the PTY running so tabs survive browser reloads. REST in `src/web/routes/terminal-routes.ts`: `GET/POST /api/terminal/sessions`, `DELETE /api/terminal/sessions/:id`. Sessions live in `RouteServices.terminalManager`.
- **UI** — `features/terminal/`: `terminal-view.tsx` is the tab strip (`+` add, `×` close, never drops to zero — last close re-spawns) over one `terminal-pane.tsx` (xterm + fit addon) per session; inactive panes stay mounted-but-hidden so shells/scrollback survive switches. Behind a **Terminal** sidebar tab.
- **Client API** — `lib/api/terminal.ts` (`listTerminalSessions` / `createTerminalSession` / `closeTerminalSession`).
- **Reuses** — the `ws` upgrade handling in `server.ts`, the SPA shell route list, `@xterm/xterm` + `@xterm/addon-fit`.
- Remaining bonus: scrollback replay on reattach (server-side per-session ring buffer), per-tab rename / cwd / shell selection, persisting the tab layout across server restarts.

---

# Expandability / tech debt

## 13. Finish the structural pass (router split already done) — ✅ DONE (ROR-13)
The web server router was split into a `src/web/routes/` registry (`server.ts` 765 → 123 lines) and the conventions are in CLAUDE.md. The remaining god-files were broken up the same way — vertical slices, ~300 lines/file soft cap — all behavior-preserving (tsc + test + build green after each):

- **`src/mcp/tools.ts` (426)** → `mcp/tools/{services,git,agent}.ts` (each a `registerXTools(server, ctx)`) + `tools/context.ts` (shared `ToolContext`, `git()`, `stringify`, recording wrapper) + `tools/index.ts` aggregator. Mirrors the routes registry.
- **`client/src/lib/api.ts` (594)** → `lib/api/{client,agent,git,services}.ts` re-exported from `lib/api/index.ts`; the `@/lib/api` import path is unchanged.
- **`features/services/service-detail-panel.tsx` (874 → 85)** → `service-detail/` slice: per-tab components (processes/http/env/logs) + `use-service-env.ts` / `use-service-logs.ts` hooks + `env-table`/`file-browser-dialog`; panel is now layout only.
- **`features/agent/agent-view.tsx` (759 → 89)** → per-tab components (`overview`/`memory`/`tools`/`activity`) + `usage-card` + `tool-call-feed`.
- **`features/services/service-forms.tsx` (564 → barrel)** → `service-form/` slice (`composer-dialog`, `service-form` + `use-service-form` hook + `presets` + `service-test-alert`, `group-form`); the old file is now a re-export barrel so importers are untouched.
- **`features/git/git-graph-view.tsx` (531 → 122)** → `git-graph/` slice (`use-git-graph` hook, `branch-tree`, `commit-list`, `commit-files-list`, `commit-diff-panel`).

Leave large *core* modules (`process-manager.ts` 683, `git-manager.ts` 412) alone unless they keep growing — they're cohesive.

---

# Net-new ideas (beyond the original list)

Most of the original roadmap has shipped. These are fresh, high-leverage additions that fit the existing architecture. Added 2026-06-13.

## 15. Error → Fix loop (closes the AI-native circle) — ⭐ highest impact
Today Error Inbox (#2), repro bundle (#8), change-set review (#11), and snapshot/restore (#6) are *separate* features the user manually chains. Wire them into one loop: a **"Fix with agent"** button on an incident hands the repro bundle to an agent run, then surfaces the result as a ROR-39 change-set with one-click restore if it goes sideways. Turns the toolbox from a set of copy-to-clipboard buttons into a closed loop — the real differentiator.

**Build:**
- **Core** — orchestration in a new `core/fix-loop.ts` (or extend `agent-runtime.ts`): take an incident id → build repro bundle → kick an agent session (auto-snapshot already fires via `agent-sessions.ts`) → on completion, resolve the change-set for that session.
- **API** — `POST /api/errors/:id/fix` → returns the agent `sessionId`; the existing change-set + snapshot endpoints carry the review/restore.
- **UI** — "Fix with agent" on each Error Inbox incident; on finish, deep-link to the Agent→Changes tab for that session.
- **Reuses** — `repro-bundle.ts`, `agent-runtime.ts` + `agent-sessions.ts`, `snapshot-manager.ts`, change-set endpoints.

## 16. Event-driven workflow triggers
Workflows are user-run today. Let them fire on events the app already detects — a new Error Inbox incident, a CI failure (`github_get_commit_ci`), or a service crash from `ProcessManager`. Small core addition on top of the existing workflow runner.

**Build:**
- **Core** — an event→workflow binding table (config schema + `core/workflows.ts` hook); subscribe to `ErrorInbox`, `github-manager`, and `ProcessManager` emitters; debounce/dedupe so one crash-storm doesn't fan out.
- **API** — CRUD for triggers under the existing workflow routes; surface fired-trigger history.
- **UI** — a "Triggers" section in `features/workflows/`: bind an event + filter → workflow.
- **Reuses** — `workflows.ts` runner, the SSE/subscribe patterns already in Error Inbox and metrics.

## 17. Inject env into a running process (the #1 leftover bonus)
Env Manager (#1) edits `.env` but requires restart-and-pray. Pushing updated vars into a live process closes that gap. Small, satisfying win — scoped to processes NoMoreIDE spawned (the existing safety boundary).

---

**Connecting theme:** vibe coders don't context-switch well. Anything that turns "tab through 5 tools to assemble a prompt" into a single button is the win.
