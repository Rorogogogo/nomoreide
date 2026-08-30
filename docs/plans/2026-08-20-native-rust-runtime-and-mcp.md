# Native Rust runtime and MCP migration plan

**Status:** Planning only. No implementation is authorized by this document.

**Goal:** Replace NoMoreIDE's Node.js runtime with one native `nomoreide` binary while preserving the current product behavior and the complete 90-tool MCP contract.

**Order:** This migration is the prerequisite for the remote-control relay. The relay must target the native Rust daemon, not add another dependency on the TypeScript daemon.

**Companion document:** `2026-08-20-repo-layout-cleanup.md` covers the directory restructuring this migration depends on. It lands as PR 2 so the crates below arrive in their final home.

## Decisions

1. Users install **one binary** named `nomoreide`.
2. MCP remains local stdio. It does not become a hosted or local HTTP MCP server.
3. An MCP client starts `nomoreide mcp`; that process automatically discovers or starts `nomoreide daemon` using the same executable.
4. Two processes may exist at runtime (the MCP stdio adapter and the machine-global daemon), but there is only one download, one installed executable, and one MCP configuration command.
5. The React dashboard remains React. Release builds may use Node.js to compile it, but the shipped assets are embedded or bundled so end users do not need Node.js.
6. Rust becomes the only owner of services, logs, terminals, agent runs, approvals, config, and runtime state. Tauri becomes a client of that runtime rather than owning duplicate managers.
7. The TypeScript implementation remains the behavioral reference until black-box parity passes. It is removed only after cutover and rollback gates pass.
8. Prebuilt binaries live in GitHub Releases. `crates.io` may provide a source-build fallback later, but it is not the primary binary distribution channel.

## Target topology

```text
Claude / Codex / Gemini
        |
        | stdio MCP
        v
  nomoreide mcp                 one installed executable
        |
        | authenticated loopback IPC
        v
  nomoreide daemon  <---->  React dashboard / CLI / Tauri
        |
        +-- services, logs, Git, databases, providers
        +-- terminals and agent runs
        +-- config and runtime state
        +-- later: outbound WSS to the hosted relay
```

The daemon continues to bind only to loopback. No migration phase may expose port `4317` publicly.

## Proposed Rust workspace

Create a root Cargo workspace. `src-tauri` becomes a member and is renamed `crates/nomoreide-tauri` (see `2026-08-20-repo-layout-cleanup.md`):

```text
Cargo.toml
crates/
  nomoreide-core/       logic and domain types; no server, no transport
  nomoreide-actions/    write-capable operations core deliberately excludes
  nomoreide-daemon/     wraps core in the loopback HTTP API; the only crate that holds state
  nomoreide-daemon-client/     talks to the daemon: discovery, authentication, typed calls; stateless
  nomoreide-mcp/        stdio MCP protocol and the 90 tool adapters
  nomoreide-cli/        the `nomoreide` binary and its subcommands
  nomoreide-tauri/      desktop shell: window, tray, native dialogs
```

### Crate responsibilities

| Crate | Owns | Replaces |
| --- | --- | --- |
| `nomoreide-core` | The actual work: spawn a process, read a repository, query a database, write config. Domain types and safety policy. | `src/core/*` and `src-tauri/src/core/*` |
| `nomoreide-actions` | The write-capable half of the safety split: `git push/pull/merge/rebase` and, later, guarded database writes and provider mutations. | `src/core/git-actions.ts`, `src/core/db-write.ts`, `src/core/vercel-actions.ts` |
| `nomoreide-daemon` | The machine-global runtime and the loopback server on `127.0.0.1:4317`. The single owner of live state. | `src/web/server.ts`, `src/web/routes/*` |
| `nomoreide-daemon-client` | Daemon discovery, lock/health negotiation, local credential, and typed method calls over loopback. Holds no state and spawns nothing. | `src/core/daemon-client.ts`, `src/core/daemon-lifecycle.ts` |
| `nomoreide-mcp` | MCP protocol framing and the 90 tool adapters. | `src/mcp/*` |
| `nomoreide-cli` | Argument parsing, subcommand dispatch, and the single shipped binary. | `src/index.ts`, `src/cli/*` |
| `nomoreide-tauri` | Native desktop surface only. No runtime managers of its own. | `src-tauri/src/commands/*` after the logic moves to core |

### The daemon is a mode, not a separate program

Consistent with decisions 1 and 4, `nomoreide-daemon` is a library that `nomoreide-cli` boots. It is never a separate download or a separate installed executable:

```text
nomoreide            the one installed binary, built by nomoreide-cli
  ├─ nomoreide daemon   boots nomoreide-daemon      long-lived, machine-global
  ├─ nomoreide mcp      boots nomoreide-mcp         one process per MCP client
  └─ nomoreide status   uses nomoreide-daemon-client       exits immediately
```

### Dependency direction is the safety mechanism

```text
              nomoreide-core        owns state, spawns processes
                    ^
              nomoreide-daemon      the only crate that links core for runtime ownership
                    ^  (loopback HTTP)
              nomoreide-daemon-client      stateless
                 ^    ^    ^
               mcp   cli  tauri
```

This direction is load-bearing, not stylistic. Today `src-tauri/src/lib.rs:22` constructs its own `ConfigStore`, `LogStore`, and `ProcessManager`, so the desktop app and the daemon each own services and neither observes the other. Keeping `nomoreide-daemon-client` unable to reach `nomoreide-core` converts that class of bug from a review-discipline problem into a compile error.

**Known nuance:** `nomoreide-mcp` will depend on both crates, mirroring today's behavior — service runtime tools go through `nomoreide-daemon-client`, while config, Git, and database tools run locally against `nomoreide-core`. The guarantee that MCP cannot spawn services therefore comes from *which* core modules it links, not from the crate graph alone. Record that dependency list explicitly and gate it in CI.

**The write side is a crate, not a module** — but not a wall against agents. The read-safe / write-capable split that `src/core/git-manager.ts` vs `git-actions.ts` draws by convention becomes `nomoreide-core` vs `nomoreide-actions` here, keeping the credential handling and the destructive-operation guards in one place instead of scattered through core.

**What it deliberately does not do is restrict who may call it.** The obvious move — forbid `nomoreide-mcp` from depending on `nomoreide-actions`, making an agent write a compile error — is wrong, and was tried and reverted during Phase 3 slice 1. The frozen 90-tool manifest includes `nomoreide_git_push`, which the reference implements by calling `GitActions.push` directly (`src/mcp/tools/git.ts`). A crate-level ban makes that tool unimplementable and breaks parity.

What an agent may do with git is defined by the **MCP tool surface**, gated by `npm run mcp:parity -- --surface-only` against that manifest — adding a write tool fails the gate. The line the reference draws is narrower than "no writes": agents get `push` (local tree untouched) and even `github_merge_pr` (server-side), but not `pull`, `merge`, `rebase`, or `checkoutDefaultAndPull` — the four that can halt mid-conflict and need a human. The reference does not document this; it is derived from the manifest and the call sites, and recorded in `crates/nomoreide-actions/src/lib.rs`.

`scripts/check-rust-dependencies.mjs` therefore still gates exactly one edge, `daemon-client → core`. When `db-write` and `vercel-actions` land in this crate, *those* are genuinely MCP-unreachable (`vercel-actions` is dashboard-only, `db-write` human-only) — but that is a per-module property the crate graph cannot express, so it needs its own gate rather than a blanket crate ban.

**Naming decision:** use `nomoreide-daemon-client` so the crate cannot be confused with the web client (`apps/dashboard`), accepting the longer path in each consumer.

The final executable is built by `nomoreide-cli` and supports at least:

```text
nomoreide mcp
nomoreide daemon
nomoreide setup <claude|codex|gemini>
nomoreide web
nomoreide status
nomoreide start|stop|restart ...
nomoreide git ...
nomoreide db ...
nomoreide remote ...       reserved for the later relay
```

Crate boundaries are architectural, not packaging boundaries. Do not ship six user-facing binaries.

## Reuse of the existing Rust implementation

`src-tauri` already contains **19,367 lines of Rust**. This migration starts from that code rather than beside it. An audit of the current tree (2026-08-20) shows the split is favourable:

| Layer | Files | Lines | Tauri coupling |
| --- | ---: | ---: | --- |
| `src-tauri/src/core/` | 19 | 6,700 | **none** — zero `tauri::`, `AppHandle`, `State<>`, or `tauri_plugin` references |
| `src-tauri/src/commands/` | 19 | 11,700 | thin — ~143 of ~180 references are the single `State<AppState>` parameter on each `#[tauri::command]` |

### `core/` moves verbatim

`src-tauri/src/core/` is not Tauri code awaiting extraction. It is already a standalone runtime library that happens to be linked into a Tauri app, and it becomes `crates/nomoreide-core` through a file move plus a `Cargo.toml` — not a rewrite. It already covers `config`, `process_manager`, `log_store`, `git_manager`, `git_identity`, `github_auth`, `service_graph`, `service_health`, `port_utils`, `external_terminal`, `agent_transcripts`, `context_library`, `one_time_skills`, and the five Vercel modules.

`core/config.rs:498` resolves `XDG_CONFIG_HOME`/`~/.config/nomoreide/` exactly as `src/core/config-store.ts:408` does, so the Rust config reader is **already proven against the production `config.json`** that the Phase 1 exit gate asks us to prove.

### `commands/` moves by mechanical unwrapping

The command modules look coupled and are not. The bodies are ordinary Rust; the Tauri surface is the attribute plus the state parameter. Each body moves into a core function taking `&Core`, and the `#[tauri::command]` shrinks to a three-line wrapper. These files *are* the later phases:

| Module | Lines | Phase it serves |
| --- | ---: | --- |
| `commands/database.rs` | 2,838 | Phase 4 |
| `commands/terminal.rs` | 2,625 | Phase 5 — already `portable-pty`, already has external-terminal reclaim |
| `commands/agent.rs` | 1,270 | Phase 5 |
| `commands/onboard.rs` | 994 | Phase 3 |
| `commands/github.rs` | 756 | Phase 3 |
| `commands/git.rs` | 598 | Phase 3 |
| `commands/vercel.rs` + `core/vercel_*.rs` | 2,462 | Phase 4 |

### The one seam that needs an abstraction

Event emission is the only genuinely Tauri-shaped dependency: roughly 22 `app.emit(...)` sites — ~13 in `terminal.rs` (`terminal-output-{id}`, `terminal-session-changed`), ~5 in `agent_chat.rs`, ~4 in `onboard.rs` — plus `AppHandle` threaded through `open_in_terminal` and `reclaim_to_dock`. The daemon needs SSE/WebSocket fan-out instead.

Define one event-sink trait (or a `tokio::sync::broadcast` channel) in `nomoreide-core`, with a Tauri implementation that calls `app.emit` and a daemon implementation that fans out to connected clients. That is one abstraction, not a duplicated stack.

### What genuinely has no Rust today

No Rust exists for the MCP server and its 90 tool adapters, daemon lifecycle/discovery/lock/authentication, or the HTTP server and route registry. On the core side, roughly two thirds of `src/core` (~67 modules, ~12,400 lines) has no Rust counterpart: `agent-env-*`, profiles and the hosted registry, `error-inbox`, `cloudflare-manager`, `vultr-manager`, `ssh-servers`, `docker`, `metrics-store`, `workflow-triggers`, `jetbrains-import`, `log-sources`, `usage-history`.

### Counterpart is not parity

Eighteen modules exist under the same name on both sides and have drifted in both directions — `process-manager` is 508 Rust lines against 891 TypeScript, `port-utils` 52 against 123, while `vercel-oauth` is 460 Rust against 86. Reuse means *start from*, never *done*. The Phase 0 parity harness remains the judge for every ported module.

## Compatibility contract

### MCP is a strict parity migration

Before implementing tools, snapshot the TypeScript server through MCP itself:

- protocol initialization response;
- server name and version behavior;
- ordered `tools/list` output;
- every tool name, title/description, input schema, required/default fields, and annotations;
- successful output shapes;
- validation and domain error shapes;
- safety behavior for guarded Git and database writes.

Commit this as `test/fixtures/mcp-contract-v1.json` plus sanitized request/result fixtures. Build a black-box parity harness that launches both implementations and compares normalized responses. Normalize only genuinely dynamic values such as timestamps, UUIDs, ports, temporary paths, and process IDs.

Parity means the existing MCP configuration can change its command without an agent having to relearn any function. Matching tool names alone is not sufficient.

### Current 90-tool inventory

| Domain | Count | Required surface |
| --- | ---: | --- |
| Services and runtime | 13 | list/register/start/stop/restart, logs, bundles, status, context, health, timeline |
| Onboarding | 1 | repository onboarding |
| Git and worktrees | 19 | status through guarded push, clone, repository/worktree management |
| Snapshots | 2 | list and create |
| GitHub | 13 | token, PRs, issues, comments, CI, workflow runs |
| Deploy providers | 4 | projects, deployments, deployment detail, logs |
| Errors | 2 | list and prompt |
| Databases | 9 | registration, inspection, sampling, guarded query |
| Documentation/UI | 3 | docs, open UI, close UI |
| Agent status | 1 | environment status |
| Agent environments | 7 | configs, doctor, MCP/skill edits and snapshots |
| Local profiles | 10 | CRUD, snapshot/apply, import/export, item copy |
| Profile registry | 3 | publish, install, GitHub registration |
| Terminal sessions | 3 | list, open, reclaim |
| **Total** | **90** | no omissions or renamed tools |

Generate the inventory from the TypeScript registry during the migration so future tool additions cannot silently miss the Rust implementation.

### Local data compatibility

Rust must read the existing documents without destructive migration:

- `~/.config/nomoreide/config.json`;
- `~/.nomoreide/daemon.json`;
- `~/.nomoreide/runtime.json`;
- agent profile, session, error, usage, and tool-call JSON stores;
- existing repository, service, database, provider, and credential entries.

For each document:

1. add representative golden fixtures from the TypeScript serializer;
2. prove Rust can read them;
3. prove a Rust round trip preserves unknown optional fields where required;
4. prove public/sanitized views never expose environment values or credentials;
5. make any schema migration versioned, atomic, and rollback-readable.

The TypeScript and Rust daemons must never write the same state concurrently. Add a single-instance lock and a daemon protocol/runtime version check before dual-run testing.

## Safety invariants that cannot change

- Git write operations keep the existing guarded paths and repository scoping.
- Database writes remain locked by default and retain preview/count/confirmation behavior.
- Public config never includes service environment values, database credentials, GitHub tokens, or provider tokens.
- Service control accepts registered definitions; it does not become arbitrary command execution.
- Port-holder termination retains expected-command and protected-process checks.
- MCP stdout contains protocol frames only. Diagnostics go to stderr or structured logs.
- The loopback API gains a random local credential for mutation routes before more clients depend on it.
- Terminal and child-process cleanup is deterministic on daemon exit.

## Delivery phases

Each phase should be a reviewable vertical slice with tests. Do not perform a big-bang rewrite.

### Phase 0 — Freeze and measure the reference

- Add the MCP contract snapshot and black-box test driver.
- Record the 90 tools and domain owners in a machine-readable manifest.
- Capture config/state fixtures and representative daemon HTTP responses.
- Record baseline startup time, idle memory, MCP first-call latency, and daemon recovery behavior.
- Add CI that fails if TypeScript tools change without updating the contract manifest.

**Exit gate:** the reference suite can launch the TypeScript MCP server and exercise all fixtures reliably on Node 20, 22, and 24.

### Phase 1 — Workspace, shared types, and local security

- Create the Cargo workspace and the six crate boundaries above, with `nomoreide-daemon-client` forbidden from depending on `nomoreide-core`.
- **Move `src-tauri/src/core/*` into `crates/nomoreide-core` and make `src-tauri` a consumer of it.** This is a file move, not a port: that directory has no Tauri coupling, so the change is behaviour-neutral and reviewable in a single sitting. Doing it here is what prevents phases 2–5 from writing a second Rust implementation beside the one that already exists.
- Introduce the event-sink abstraction in `nomoreide-core` and route the existing `app.emit` sites through it, keeping the Tauri implementation as the only one for now.
- Fill remaining gaps in the ported config/state layer: atomic filesystem helpers, redaction, path containment, and runtime-state types.
- Implement daemon discovery, lock ownership, health/version negotiation, and a mode-`0600` local credential.
- Add `nomoreide mcp` with initialization and `tools/list` from the frozen manifest; tool calls may return a typed `not_implemented` only on the development branch.

**Exit gate:** the native binary starts on supported targets, lists the exact 90-tool contract, reads existing config safely, and cannot run beside another active daemon owner. The desktop app builds and behaves identically while owning no core module of its own.

**Why this ordering.** The original sequencing deferred all Tauri convergence to Phase 6 and limited Phase 1 to sharing serializable types. That guarantees three concurrent implementations — TypeScript, Tauri-owned, and daemon-owned — for five phases, with the Tauri copy drifting the whole time. Lifting `core/` first costs one mechanical PR and makes every later phase extend a single implementation.

### Phase 2 — Canonical service runtime

- Port process management, service registry, service graph, logs, health, metrics, SSH service execution, Docker helpers, and bundles.
- Preserve argument-vector execution; never collapse structured commands back into shell strings.
- Implement the matching daemon API and the 13 service/runtime MCP tools.
- Port timeline/error recording needed by those tools.
- Add process-tree cleanup, restart, port-conflict, protected-process, and crash-recovery tests.

**Exit gate:** a clean-machine black-box suite produces equivalent service states, logs, health, and errors through TypeScript and Rust.

**Exit gate met** by `npm run mcp:runtime-parity -- ./target/debug/nomoreide`
(`scripts/check-mcp-runtime-parity.ts`). It gives each runtime a private
throwaway home, an identical service config, and one ordered walk of 55 MCP
calls covering every state a service reaches — running, exited, stopped after
running, never started, restarted, bundled, refused — across all three kinds
(`local`, `ssh`, `docker-compose`). Pass `--dump` to print both payloads per
step.

The suite compares payloads rather than reading either implementation, and
normalizes only what cannot repeat between two equivalent runs: pids, ports,
wall-clock times, and each runtime's own paths. States, exit codes, signal
names, and message text are compared verbatim.

Hermetic by construction: `ssh` and `docker` are stubs planted in each
runtime's workspace. A stub needs `SHELL` as well as `PATH`, because
`service_path()` asks the login shell what PATH to hand a service and appends
the inherited one last — a stub reachable only through `PATH` loses to a real
`/usr/local/bin/docker`.

**Four accepted divergences.** Each is erased by the narrowest rule that
describes it, so every other field in those steps is still compared; the two
that can be stated exactly are pinned on *both* sides, so the gate fails if
either runtime changes.

| # | Difference | How the gate treats it |
| --- | --- | --- |
| D1 | A stop that finds no live child makes the reference replace the whole status record with a bare `{name, state}`, discarding the exit code, signal, pid, and URL it had just reported. The native runtime carries the record forward. | Reconciled: where the reference collapsed a record, only what it kept is compared. |
| D2 | The reference answers a stop for an unregistered name by *inventing* a runtime entry and timeline event for it, which then persist in every later read. The native runtime refuses — stop is a remediation capability, but only for names that were once registered (`require_stop_allowed`). | Pinned at `error/stop-unregistered`; the invented name is dropped from later reads. |
| D3 | The reference records every stop twice — once from the exit watcher (carrying exit code and signal) and once more from `stopService` itself (carrying no `data`). The native runtime records only the authoritative one. | Reconciled: the data-less twin is dropped. |
| D4 | An ssh service's environment is emitted as shell assignments before `exec`. The reference emits them in config-file order; the native runtime parses `env` into a hash map and emits them sorted. Same environment, different argv text. | Pinned at `logs/ssh-argv`; assignments are sorted elsewhere, so which variables are exported and with what quoting is still compared exactly. |

In all four the native behavior was judged the better one, so the reference is
the side that would change. Two further differences are races present in both
runtimes, not divergences: a service's URL is parsed out of stdout
asynchronously, so a *start* call may return before or after it lands (the
`status` step after each start compares it once settled); and the stdout and
stderr readers race, so timeline events belonging to different services can
interleave either way (order within one service is deterministic and still
compared).

### Phase 3 — Git, GitHub, worktrees, snapshots, and onboarding

**Slice 1 (done): the read/write split, before anything is built on it.** The
Rust `git_manager.rs` inherited from Tauri had collapsed the boundary the
TypeScript keeps — 857 lines with `push`, `pull`, `merge`, and `rebase` sitting
beside `status` and `diff`. `push_with_credential`, `pull`, `merge`, `rebase`,
and `pull_default` moved to `nomoreide-actions`, taking the credential helper
and the redaction with them; the read-safe remainder split by responsibility into
`git_manager/{types,exec,inspect,branches,files,worktrees}.rs`, each inside the
~300-line budget. `nomoreide-actions/tests/git.rs` ports
`test/git-actions.test.ts` so both runtimes answer to the same cases.

One thing this slice got wrong and corrected: it first forbade `nomoreide-mcp`
from depending on the new crate, on the assumption that the read-safe /
write-capable table in `CLAUDE.md` meant agents cannot write. Checking the
frozen manifest instead of the table showed `nomoreide_git_push` is an MCP tool,
so the ban would have broken parity. See "Dependency direction is the safety
mechanism" above for where the boundary actually lives.

Two behaviours were carried over verbatim rather than reconciled, and were
closed out at the end of Phase 3 (see "Slice 9" below): `pull_default` used
`checkout` and swallowed its error where the TypeScript `checkoutDefaultAndPull`
uses `switch` and reports one, and the Rust `default_branch` had no fallback to
a local `main`/`master` when `origin/HEAD` is unset.

**Slice 2 (done): repository registration and selection.**
`nomoreide_git_register_repository` and `nomoreide_git_select_repository` are
the first two of the 19 git tools, and every other one needs "which repository
am I acting on" resolved first. Both write config and never touch the runtime,
so they are served locally without a daemon, like service registration.

Diffing against the running reference — rather than reading its source — found
three gaps that reading had missed. The Rust `ConfigStore` registered a
repository without selecting it (the reference always selects, so re-registering
a known name also brings it forward), let `select_git_repository` name a
repository that was never registered, and validated neither that the path is
absolute nor that it is inside a worktree. The first two are fixed in
`config.rs` with tests; the last two live in the tool, which is where the
reference puts them.

The gate is `npm run mcp:git-parity -- ./target/debug/nomoreide`
(`scripts/check-mcp-git-parity.ts` + `test/fixtures/mcp-git-parity-v2.json`),
now on every PR. It gives each runtime a private home and its own copy of every
fixture repository, then walks an ordered plan of MCP calls and diffs the
payloads. No daemon is involved — these tools write `config.json` directly.
Placeholders (`{{repo:demo}}`, `{{dir:...}}`, `{{home}}`) become each runtime's
own paths, and those paths are the only thing normalized away; message text and
every field are compared verbatim. Payloads are compared parsed, so key *order*
— which `serde_json` sorts and the reference does not — is not a difference.
**17 steps, no accepted divergences.** Verified to bite by removing the
auto-select and watching it fail.

Add steps to the fixture as each remaining git slice lands, rather than building
the whole Phase 3 gate at the end.

**Slice 3 (done): the reads — status, branches, diff, staged diff, log.**
These five were the first slice that was a *port* rather than a move. The Rust
`GitManager` already had read methods, written for the desktop app, and diffing
them against the running reference showed most of them answering a different
question:

- `status` named the branch with `rev-parse --abbrev-ref HEAD`, so a detached
  HEAD came back as a branch called `HEAD` rather than as no branch at all; it
  also rendered a missing upstream as an explicit `null` where the reference
  omits the key.
- `diff` returned the *staged* diff whenever there was one, and there was no
  `staged_diff` at all.
- `log` did not exist — `graph` is a different shape for the desktop commit
  graph.
- `branches` read two commands, so it could not mark the current branch's
  upstream, and it listed `origin/HEAD`, which is a pointer at a branch already
  in the list rather than a branch.
- The runner swallowed non-zero exits, so a read outside a repository returned
  nothing instead of git's `fatal:`, and reported a `cwd` that does not exist as
  "git command failed" rather than naming the failure. It now follows the
  reference's rule exactly — stdout, else stderr; on failure stderr, else
  stdout, else why the process never started, trimmed — and names a spawn that
  never happened the way Node does, `spawn git ENOENT`.

All of these are fixed in `nomoreide-core`, not worked around in the tool, so
the desktop app gets the same corrections. `GitBranch` now carries the
reference's own field names and its `upstream`, which let
`apps/dashboard/src/lib/api/tauri-bridge.ts` drop the `adaptBranches` translation
layer that existed only because the two had drifted.

The fixture grew to **45 steps** and its format to version 2: a repository is
now built from an ordered list of declarative setup steps (commit, remote,
`remoteHead`, `resetTo`, branch, detach, write, remove, stage) rather than a
list of commits, and every commit is stamped with one fixed timestamp so both
runtimes produce byte-identical hashes and `nomoreide_git_log` can be compared
as reported. The demo repository ends up **two ahead and one behind** its
upstream — deliberately different numbers, because equal ones let a swapped
left/right column pass. Verified to bite on three seeded regressions: the
swapped columns, a dropped `origin/HEAD` filter, and the old detached-HEAD
branch name.

**Slice 4 (done): worktrees — list, create, select, prune.**
The four worktree tools, and the largest set of gaps so far. Every one was
found by diffing against the running reference:

- The listing read `worktree list --porcelain` without `-z`, so a path or a
  lock reason containing a newline was read as the start of another record.
- `create` and `remove` matched worktrees by string equality. git reports the
  *resolved* path, and on macOS the managed root sits under a symlinked
  `/var`, so the string git printed was never the string the code had built —
  creating a worktree failed with "Git created the worktree but it could not
  be found" on the very platform the desktop app ships for. Both now compare
  canonically.
- `create` required a project name; the reference falls back to the
  repository's own folder name.
- `safe_segment` replaced each unsafe character, where the reference replaces
  each unsafe *run*, so `My // Project` produced four dashes instead of one.
- `createdAt` was whole milliseconds against the reference's fractional
  `birthtimeMs`, and an absent branch, lock reason, or prune reason rendered
  as an explicit `null` where the reference omits the key.
- `select_git_worktree` stored whatever path it was handed, without checking
  that it was absolute or that it belonged to *that* repository. It now
  refuses both, and stores the path git reports rather than the spelling
  passed in. The desktop app's own by-string membership check is gone: it had
  the same symlink bug, and the store now answers the question canonically.

Two validations moved *into* `ConfigStore::register_git_repository` — that a
path is absolute, and that it is inside a worktree. Slice 2 put them in the MCP
tool; the reference has them in the store, which is the difference between an
agent being refused and the desktop app registering the same bad folder
silently.

**Worktree failures read differently from every other git read, and that is
faithful.** The reference runs these four through Node's `execFile` directly
and lets its rejection through, so an agent sees `Command failed: git worktree
add …` and then git's own words; the reads go through a wrapper that re-throws
git's stderr alone. `command_failed` reproduces that, asserted literally in a
unit test.

The fixture is at **74 steps**. `createdAt` is the one field normalized beyond
paths — it is the wall-clock birth time of a directory each runtime creates for
itself, so it can never match; the mask only forgives the digits of a
plausible number, so an omitted or wrong-typed one still differs. Note the
limit: the fractional-vs-whole millisecond fix is therefore *not* what the gate
proves, only the unit-level shape is. Verified to bite on four seeded
regressions: the missing `-z`, a bare-stderr failure, string path comparison,
and the per-character `safe_segment`.

**Slice 5 (done): the local write ops — stage, unstage, commit, create/switch
branch, fetch.** Six tools, and the first slice where a Rust method silently
reported success for a failed git command: `unstage` ran `restore --staged` and
discarded the exit status entirely, so an agent unstaging a path git had never
heard of was told it worked. Also fixed:

- Every one of these returned `()`. The reference returns what git said — the
  commit summary, the "Switched to a new branch" line — which is the only
  report an agent has that the thing happened. They now return `String`, and
  the desktop commands hand it back rather than dropping it.
- `stage` bailed with git's stderr untrimmed; all six now go through
  `exec::checked`, which is the reference runner's rule in one place.
- Neither `stage` nor `unstage` checked that it had been given a path.
  A path of only spaces clears the schema's length check and would reach git as
  an argument meaning the current directory — staging everything instead of the
  nothing that was named.
- `commit` did not refuse a blank message.
- `validate_branch_ref` reported a branch that looks like an option ("-x") as
  *missing* rather than invalid, and could not name a start point in its
  refusal. It now takes a label and tells the two mistakes apart.

`nomoreide_git_commit` needed the commit-identity path, which needed
`repository_for_cwd` — so `src/core/repo-match.ts` is ported as
`crates/nomoreide-core/src/repo_match.rs`, with its strictness intact: an
ambiguous or nested directory is refused rather than resolved, because the
answer decides which GitHub account a commit is attributed to. It is also what
`push` and the GitHub context will need.

The fixture is at **111 steps**, on a `writes` repository the read steps never
touch. The MCP process now runs with a fixed `GIT_AUTHOR_DATE`/
`GIT_COMMITTER_DATE`, so a commit made *by a tool* is byte-identical across the
two runtimes and `nomoreide_git_commit` is comparable as reported. Verified to
bite on four seeded regressions: the swallowed `unstage` status, the missing
blank-message check, the mislabelled option-shaped branch, and blank paths
reaching git.

**Slice 6 (done): push, clone, and storing a GitHub token.** The last two git
tools plus `nomoreide_github_set_token`, which is the config write the other
twelve GitHub tools will read. Nothing here talks to api.github.com, so the
whole slice is diffable against bare origins in the fixture's own tree — the
twelve API tools need a different arrangement and land next.

Two credential leaks in the *reference* were found by this slice and fixed in
both runtimes rather than replicated:

- `nomoreide_git_register_repository`, `_select_repository`, and
  `_select_worktree` answered with the raw config, which holds every stored
  GitHub PAT. The dashboard's own API has always sent `publicConfig(...)`, and
  the service registration tools already did too — these three were the
  oversight. The Rust port had been redacting from the start, which is how the
  gate found it: the divergence only appears once a token is stored, and this
  is the first slice that stores one. `test/mcp-git-config-redaction.test.ts`
  covers it directly.
- A clone of a private github.com repository puts the token in a `-c
  http.…extraheader=Authorization: Basic …` argument, and git's failure text
  quotes the command back. The encoded value is now blanked on the way out.
  Not reachable from the fixture (it needs a real github.com URL), so it is
  covered by a unit test rather than by the gate.

Aligned to the reference besides: `GitActions`' runner named a spawn failure in
prose where the reference reports Node's `spawn git ENOENT`, and had no wording
at all for a command that failed while printing nothing.

`repo-onboard.ts`'s clone half is ported as
`crates/nomoreide-core/src/repo_onboard.rs` — URL parsing, the managed repos
directory, and the clone itself. The scan/profile half stays in TypeScript
until the onboarding slice.

The fixture is at **140 steps**, with a `pushes` repository nothing else
touches and a bare origin named `~~Odd~~Name~~` whose only job is to be
sanitised — project naming is otherwise invisible to the gate, because every
other fixture name is already a legal one. Verified to bite on eleven seeded
regressions across push (no upstream, detached HEAD allowed, prose spawn
failure, untrimmed error), clone (no registration, no destination check, no
lowercasing, per-character dashes, untrimmed dashes), and the token
(repository not pointed at it, appended rather than replaced).

One thing the gate cannot show: `parse_repo_url` strips a trailing `.git/` and
`sanitize_name` strips `.git` again, so removing either leaves the other to
produce the same name. That redundancy is in the reference too, and no fixture
step can tell the two apart.

**Slice 7 (done): the twelve GitHub API tools.** The first tools that reach
outward, so the first that could not be diffed by running both runtimes and
watching. Each runtime is now pointed at **its own loopback stand-in for
api.github.com** (`scripts/support/github-api-stub.ts`), and the gate compares
two things per step: what the tool reported, and every request it made to get
there — method, path and query, headers, and body. Without the second half a
runtime that built `?branch=main&per_page=30` instead of `?per_page=30&branch=main`
would only show up as a 404 against a real API, which is not a failure anyone
could read.

That needed one seam in the reference: `githubApiBase()` honours
`NOMOREIDE_GITHUB_API_BASE`, **but only when it names a loopback address**.
Every request through that base carries a bearer token, so an override that
could name any host would turn one environment variable into a way to post the
user's credential somewhere else. Anything else — another host, another scheme,
an unparseable value — falls back to GitHub rather than failing, and both
runtimes have a unit test for the refusal list.

The gate found one wording divergence in Rust's credential precedence, which
had been there since before this port: `github_auth::resolve` named the host in
"No stored GitHub token configured for github.com." even when the repository
had never chosen a host. The reference names it only when a *stored* selection
picked it, because naming a host the user never picked reads like a setting
they had got wrong.

`GithubManager` deliberately passes most responses through as GitHub sent them.
The reference reshapes only two things — a pull request, and a commit's checks
— and a Rust struct for the rest would silently drop every field GitHub adds
later. So issues, comments, merges, and workflow runs travel as `Value`.

The fixture is **46 steps against 25 canned routes**, covering all five check
states, a merged pull request reported as "closed", the two fields a list
response omits, the pull requests GitHub mixes into the issues endpoint, the
404 that is answered rather than raised, and both error shapes (GitHub's own
`message`, and the status line when the body is not JSON). Verified to bite on
fourteen seeded regressions.

Two things this slice does not do, both recorded rather than hidden:

- **The ETag revalidation cache is not ported.** The only Rust caller is the
  MCP server, which is a fresh process per tool call, so a cache could never be
  read there. It belongs with the daemon's GitHub routes, where it is what
  keeps the dashboard's polling inside GitHub's rate limit.
- **`crates/nomoreide-tauri/src/commands/github.rs` still has its own client**,
  with a different auth scheme (`token` rather than `Bearer`) and different
  error wording. Pointing it at `GithubManager` is a Phase 6 call-site change,
  not a manager replacement.

The gate does not compare `User-Agent`: undici and reqwest each send their own,
both non-empty, and neither is something this port chooses.

The two Phase 3 gates now share `scripts/support/mcp-parity-fixture.ts` — the
throwaway repository tree, the path tokens, and the payload normalization — so
a third gate is a plan and a stub, not another copy of the harness.

**Slice 8 (done): snapshots and onboarding.** `snapshot_manager.rs` builds its
tree in a scratch index so a checkpoint never disturbs what the user had
staged, and `repo_onboard.rs` gained the scan half it was missing — the
profile, the service proposals, and the database proposals. Gated by
`npm run mcp:onboard-parity` (84 steps), verified against 41 seeded
regressions of which it catches 39; the two it cannot are noted in the code.

**Slice 9 (done): the two carried-over divergences.** `pull_default` now
matches `checkoutDefaultAndPull` — `switch` rather than `checkout`, the switch
output surfaced, a local `main`/`master` standing in for a missing
`origin/HEAD`, and a refusal rather than a guess when none of the three is
there. It returns `{ branch, output }`, which also let the desktop bridge stop
inventing an empty branch name.

Neither `pull` nor `pull_default` is an MCP tool, so no MCP gate can see them;
`npm run git-actions-parity` drives the crate's own probe example instead (18
cases, 13 of 13 seeded regressions caught). While writing it, the crate doc's
claim that all four guarded operations share the clean-tree check turned out to
be wrong — `pull` and `pull_default` rely on `--ff-only` instead — and was
corrected.

**Phase 3 is complete.** Its exit gate is met: 90 tools on the manifest,
parity fixtures covering clean and dirty repositories, detached HEAD, remotes,
worktrees, PR/issue errors, and the snapshot boundaries.

Still open, deliberately, and recorded so neither is lost:

- The ETag revalidation cache the reference keeps at module scope is unported.
  The only Rust caller today is the MCP server, a fresh process per tool call,
  where a cache could never be read. It belongs with the daemon's GitHub routes
  in Phase 6, where it is what keeps the dashboard inside GitHub's rate limit.
- `crates/nomoreide-tauri/src/commands/github.rs` still carries its own GitHub
  client with `token`-scheme auth and different error wording. Pointing it at
  `GithubManager` is a Phase 6 call-site change.
- Whether to expose `merge`, `rebase`, and `pull` to MCP is an open product
  question, not a port gap. It belongs in the TypeScript reference first so
  both runtimes stay diffable.

- Extract/port the existing Rust Git/Tauri work, then fill gaps against the TypeScript reference.
- Port GitHub authentication and API operations without changing credential precedence.
- Port snapshots, repository selection, worktree management, context assembly, and onboarding.
- Implement the 35 MCP tools in these domains and their guarded write cases.

**Exit gate:** parity fixtures cover clean/dirty repositories, detached HEAD, remotes, worktrees, PR/issue errors, and snapshot restore boundaries.

### Phase 4 — Databases, providers, errors, and documentation

**Slice 1 (done): the database read/write split, before anything is built on
it.** `crates/nomoreide-tauri/src/commands/database.rs` had grown to 2,836
lines with the reads, the writes, and the file export all in one place — and it
was about to become the foundation for nine agent-reachable MCP tools. Split
the way Phase 3 slice 1 split git:

- Read-safe, and what the agent will reach: `nomoreide-core/src/db/` as
  `{types,sql,engine,catalog,details,rows}.rs` plus a facade, each inside the
  ~300-line budget. All three engines enforce read-only underneath — a
  `READ ONLY` transaction for Postgres and MySQL, a read-only connection for
  SQLite — so the guarantee is the driver's, not a keyword check's.
- Write-capable, and reached by no MCP tool: `nomoreide-actions/src/db.rs`,
  beside `git.rs`, holding execute, the structured delete, and the affected-rows
  preview.
- The desktop commands became thin wrappers, keeping only the file export,
  which is neither: it reads rows but streams them to disk and can be cancelled,
  so it holds Tauri's own cancellation state.

The eight existing tests moved with their subjects — four to core, three to
actions, one stayed with the export — and core seeds its own fixtures through
`sqlx` rather than borrowing the write crate, which would have inverted the
dependency the split exists to enforce.

Two behaviours were carried over verbatim rather than reconciled, and slice 2
settled both against the reference — see below.

One thing this slice cost: the local Windows cross-check no longer covers
`nomoreide-core` or anything that depends on it. `sqlx` pulls in `ring`, whose
build needs a mingw toolchain this machine does not have. It is not a CI gate
(there is no Windows job) and the desktop app already carried `sqlx` through
`nomoreide-tauri`, so nothing about the product's Windows story changed — but
the check now only reaches `nomoreide-daemon-client`.


**Slice 2 (done): the nine database MCP tools.** Every shape was read off the
running reference rather than out of its source, and the gate is
`npm run mcp:database-parity` — 113 steps against a SQLite file each runtime
gets its own copy of. What the probing settled:

- The agent surface is *not* the dashboard's read path, which is why it now has
  its own module (`core/src/db/peek.rs`, mirroring the reference's own
  `db-peek.ts`). A row comes back as an object keyed by column name, bytes come
  back as bytes rather than `<blob 3 bytes>`, and a query's columns are named by
  the statement rather than by the catalog. The dashboard's lossless-integer
  casting is *not* applied here.
- The row cap is `SELECT * FROM (…) LIMIT ?` with the cap bound and one row
  over-fetched: `truncated` is whether the extra row arrived, which is why a
  limit equal to the row count reports false.
- The keyword allowlist carried over from the desktop turned out not to be a
  gate at all. The reference runs the statement first and consults the keyword
  only when it *failed*, to decide whether to answer with a driver error or with
  the write-staging prose. The allowlist is `select|show|describe|desc|explain|
  pragma` — `with` and `values` are absent, so a CTE that fails is answered as a
  refusal. Replicated exactly, including that asymmetry.
- `mask_url` does not return `****` for a URL with no scheme separator. It
  parses the URL and replaces only the password, and falls back to first-four +
  `****` + last-four for anything unparseable, or `****` when that would be most
  of the string. The Rust version was wrong on every count and was replaced.
- `projectPath` is omitted when absent rather than reported as null.

Three fixes fell out of building it, each of which had been quietly returning
nulls in the *dashboard* too:

- SQLite cells were decoded by the column's *declared* type, so a `PRAGMA`
  result — which has no declared types — read back as a column of nulls. Index
  uniqueness and the entire foreign-key list were being dropped. Now decoded by
  what the value actually holds.
- sqlx's framing (`error returned from database: (code: 1) …`) was reaching
  callers instead of the database's own message.
- `-0.0` and non-finite floats were serialized as themselves, which no JSON
  reader on the other end can distinguish or accept.

Documented divergences, none of them gated:

- Postgres and MySQL are unexercised: a fixture cannot stand up a server without
  testing the server. Their catalog SQL, their `schema.name` qualification, and
  their drivers' connection-failure text are unchecked. The reference reports an
  *empty* message when it cannot reach Postgres; the native runtime reports what
  sqlx says, which is the better answer and not worth matching.
- Integers past 2^53: the reference cannot report one at all — `node:sqlite`
  throws rather than lose precision, so sampling a table holding one fails. The
  native runtime returns the number.
- A statement that closes the wrapper's parenthesis and comments out the rest of
  the line takes the bound cap with it. SQLite runs the shortened statement and
  sqlx lets the homeless parameter go; the reference's driver raises "column
  index out of range". Both stay read-only, so what differs is how loudly a
  caller escapes their own row cap.

**Slice 3 (done): the three documentation-and-UI tools.** The whole of the
manifest's `documentation-ui` domain, gated by `npm run mcp:docs-ui-parity` —
22 steps, half of which need no daemon and half of which need one each.

- `nomoreide_docs` is a static table of twelve topics plus an index. Every
  entry in the native table was transcribed from what the reference *reported*
  for that topic, not from its source.
- The overview named a hardcoded `v0.1.99` — four releases behind the package
  it described, and drifting further with every release. Both runtimes now
  interpolate their own version into a `{version}` placeholder, which is the
  one thing in that table that is not a literal. This is a change to the
  reference, not only to the port: replicating the drift would have shipped a
  second runtime that tells agents the wrong version forever.
- `nomoreide_open_ui` distinguishes five states. Four of them — `already_running`
  (the state file named a daemon and it answered), `adopted` (the port answered
  with no state file naming it), the foreign-port refusal, and `stopping` /
  `not_running` from `nomoreide_close_ui` — are gated. The fifth, `started`, is
  not: reaching it means no daemon is running, and the reference is launched
  from `src/index.ts`, which refuses to spawn one. Everything up to the spawn is
  shared and compared; the spawn is covered by the native runtime's own tests.
- Two things the native runtime lacked and now has: `POST /api/daemon/shutdown`
  on the Rust daemon, wired to the same drain a SIGTERM pulls on rather than to
  a second exit path, and `nomoreide-daemon-client/src/lifecycle.rs`, which owns
  "reuse, adopt, or spawn" so that no front end grows a second answer to it.

**Slice 4 (done): the error inbox.** Two MCP tools, and the detector behind
them. Gated by `npm run mcp:errors-parity` — 16 steps, one of which compares
28 incidents with their excerpts, files, and counts.

The reason this is a slice of its own rather than three lines in slice 3: both
tools were dead. `nomoreide_list_errors` returned `[]` and
`nomoreide_error_prompt` answered "Incident N not found" **on every machine,
for every user**, because they read an `ErrorInbox` living in the MCP adapter
process — which never spawns a service and so never sees a log line. The daemon
owns the services, has the incidents, and serves them correctly at
`GET /api/errors`; the tools were simply left in the "runs locally" bucket when
service runtime moved to the daemon. Both runtimes now read the daemon's inbox,
which is a fix to the reference as well as a port.

That made porting the detector unavoidable — and worth doing anyway, since the
dashboard reads the same endpoint. Everything below was read off the running
reference:

- The word list is **not** the log store's severity list. The inbox counts
  `error`, `fatal`, `panic`, `exception`, `uncaught`, `unhandled`,
  `segmentation fault`, `eaddrinuse`, `econnrefused`; the log store also counts
  `traceback`, which the inbox does not. Conflating them would change what an
  agent is shown.
- The error pattern has a **trailing** word boundary and no leading one, so
  `terror` is an incident and `errors` is not. Replicated as observed.
- A literal `0 error(s)` exempts a line — a build reporting zero errors is
  announcing success — and the exemption applies to errors only, not warnings.
- A signature is `{service} {normalized line}`, normalized by replacing ISO
  instants, `0x…` literals, and whole numbers, collapsing whitespace, and
  cutting at 200 characters. It is built from the **whole line**, not from the
  240-character title: normalizing first is what lets a long line of varying
  numbers sign by what it says rather than by where the title happened to end.
- A frame needs both an extension and a column — `path.ext:line:col` — or
  Python's `File "…", line N`. Without the extension `ECONNREFUSED
  127.0.0.1:5432` and an ISO instant both read as frames, which is how the
  first port of this had an incident blaming `2026-08-22T13`.
- The excerpt is the twelve lines ending at the message, plus up to twelve
  *stack continuations* — an indented `at …` or `File …` — appended as they
  arrive. A continuation joins the excerpt even when it resolves to no file, so
  a Java frame is kept rather than leaving a hole in the trace.
- A file is resolved once: the last frame in the window at creation, or the
  first continuation that resolves after it. Later frames never overwrite it.
- The inbox keeps a hundred incidents and drops the oldest; listings are
  ordered by most recent activity.

One visible consequence of the fix: with no daemon running, both tools now say
so, where `nomoreide_list_errors` used to answer `[]`. That is the same
behaviour every other daemon-backed tool already had, and an empty list was the
worse answer — it read as "nothing is wrong" when the truth was "nothing is
being watched".

The gate caught 40 of 40 seeded regressions, but only after two rounds: the
first sweep read 32/40, and seven of the eight misses were gaps in the fixture
rather than in the port — no line carried a zero-count *and* a warning word, no
line had internal runs of whitespace, none led with spaces, none was indented
without being a frame, no two services shared a message, no incident's only
frame-shaped line lacked a column, and the default limit is invisible while the
inbox holds fewer incidents than any plausible default. All seven are now
fixture lines, and the re-run caught 8/8.

One implementation trap worth recording: `LogStore` calls its listeners while
holding its own write lock, so the first version of the inbox — which read the
store back to build an excerpt — deadlocked the thread delivering the line. The
inbox now keeps its own twelve-line window per service, which is also a better
description of what an excerpt is.

**Slice 5 (done): the deploy tools.** The four provider tools end to end for
both registered providers, gated by `npm run mcp:deploy-parity` — 63 steps,
each comparing both what the tool reported *and* every request it made to get
there. It landed in two commits, Vercel then Cloudflare.

Three things had to exist before anything could be diffed:

- **A loopback seam.** These tools reach a vendor over HTTPS, so — unlike git
  or the database — they cannot be diffed by running both runtimes and
  watching. `providers/api-base.ts` and its Rust twin hoist the seam
  `githubApiBase()` opened into the provider layer, loopback-only for the same
  reason: every request carries a bearer token, and an override that could name
  any host would turn one environment variable into a way to post the user's
  credential somewhere else.
- **The egress boundary, in Rust.** The TypeScript daemon scopes each provider's
  `fetch` to its manifest's hosts and follows redirects by hand so every hop is
  checked. The native daemon had none of that, which would have made this
  migration quietly delete a security control. `providers/egress.rs` is the same
  two rules and the same manual redirect walk. Each manifest's host list is now
  *derived* from its base URL rather than written out beside it, so the
  allowlist and the place requests actually go cannot drift apart.
- **A way to start connected.** A provider connection is written by an OAuth
  callback or a dashboard form, and a gate driving the MCP surface can drive
  neither — so a parity fixture can now plant a `config.json`. The gate walks
  its plan twice, once connected and once not, because "not connected" is the
  state most users are in and its message is the one they read.

What the probing settled, none of it from reading the reference:

- A project's `settings` is a fixed, labelled list, and an entry appears only
  when the vendor carries that key **at all**. Present-but-null is a setting the
  user cleared; absent is one Vercel does not have for this project. The
  desktop app's own normalization flattens both to `null`, which is why the
  provider layer is a second normalization rather than a reuse of the first.
- `link` is reported only when it names a git host. Vercel sends `link: {}` for
  a project imported without one.
- `isCurrentProduction` is `target === "production"` *and not* `readySubstate
  === "STAGED"` — built for production but not serving it is not current.
- A `preview` filter is applied client-side. Vercel has no preview target, so
  the request is unfiltered and everything not `production` is kept.
- Build log lines sort by `payload.date ?? created ?? 0`, keep leading
  whitespace and drop trailing, strip ANSI, and skip anything whose text is
  empty after that. A top-level `text` is not read; the event `type` is ignored
  entirely, so a delimiter is still a line.
- **The query encoding is `URLSearchParams`, not `encodeURIComponent`.** Setting
  the team scope re-serializes the whole query as form-encoded, so a search for
  something with a space in it goes out as `+` and not `%20` — and that string
  is quoted verbatim in the error a failed request reports, so it is visible to
  the caller and not only to the vendor.

One defect fixed in the reference rather than replicated: a build event whose
`text` was not a string threw `.replace is not a function` out of the whole log
read — an unreadable failure in place of the one line it could not use.

**The Cloudflare half** is a port from nothing — the Rust core had no
Cloudflare at all, only Vercel inherited from the desktop app. Pages describes
a deployment in nothing like Vercel's terms, and the vendor-neutral shapes are
where that stops being every caller's problem:

- A project's id **is its name**. Pages addresses projects by name, and the
  opaque `id` it also carries addresses nothing.
- Its four settings are *always* reported, where Vercel's six appear only when
  the vendor carries the key. Pages nests them under `build_config` and omits
  the whole object for a project it has never built, so "absent" there would
  mean "never built" rather than "this setting does not exist".
- A deployment reports a *stage* and its *status* rather than a ready state.
  Three statuses mean something a person acts on and the rest are work in
  progress — but a deployment with **no stage at all** is queued rather than
  building, which is why the mapping takes an option rather than a defaulted
  status: `idle` on a real stage means the stage is running.
- `is_skipped` is its own state (`canceled`, raw `skipped`), because a skipped
  deployment never ran and its stage says nothing useful.
- Current production is the project's `canonical_deployment`, not the newest
  production-targeted build: Pages serves an older one after a rollback, and
  can serve a preview URL as the canonical one. That read is issued *alongside*
  the listing rather than after it — which the gate compares, so the native
  runtime had to be concurrent too.
- Only a finished build has a ready moment. For anything else `modified_on` is
  just the last time the record changed.
- A capped build log keeps its **end**. A capped log is read to find out why a
  build failed, and that is the last thing it says. (Vercel gets the same answer
  from the vendor, which reads its events backwards.)
- Pages records no failure message on the deployment — the reason is in the
  build log — so the detail names the stage that failed, which is what tells
  "the build broke" apart from "the deploy broke".
- Everything paginates ten at a time with no way to ask for more, so a listing
  is a walk. It stops at a short page or a hundred items.

One narrowing in the gate, and it is worth being precise about: nine Cloudflare
steps compare their requests as a sorted list rather than in arrival order,
because each issues two requests deliberately at the same time and which
reaches the socket first is decided by connection setup rather than by either
implementation. The method, the full path and query, the headers, the body, and
the *number* of requests are all still compared.

**A fifty-seed sweep says the gate bites.** Each seed changes one behaviour in
the Rust source, rebuilds, and runs the gate; a seed the gate does not notice is
a hole in the gate, not a passing test. Seven survived the first pass, and every
one of them was a missing *case* rather than a wrong port — the fixture had no
input that could tell the mutation apart:

- No deployment carried both `uid` and `id`, so which one wins was unobservable.
- None carried an explicit `errorMessage: null`, so dropping a null was
  indistinguishable from dropping an absent key.
- `cf_canonical` was the only production Pages build, so "the canonical one" and
  "the newest production one" agreed. A rollback fixture now separates them.
- Every Pages project name and every git remote in the fixture was already
  lowercase, so both case-folding rules were free to disappear.
- One seed is retired rather than fixed: Cloudflare account ids are 32 hex
  characters, so interpolating one raw and encoding it produce the same string.
  A fixture with a space in the account id would be testing something the vendor
  never issues.

With those cases added the gate catches all forty-nine remaining seeds.

Two things the errors gate turned up while re-running everything, both fixture
problems rather than port problems, and both now fixed: its flood step waited a
fixed six seconds for a hundred and five lines (now it waits for the condition
it actually needs), and the reference occasionally delivers two adjacent stderr
lines out of order, which reorders the pair in a listing sorted by when each was
last seen. The native runtime was never the one that varied. The two emitters
where it showed up now space their lines further apart.

- Port database registration, catalog inspection, sampling, masking, and guarded queries.
- Support the same database engines and URL redaction behavior as today.
- Port the provider registry and Vercel/Cloudflare/Vultr HTTP behavior used by MCP and dashboard APIs.
- Port error inbox/prompt generation and embedded documentation/UI lifecycle tools.
- Implement the 18 MCP tools in these domains.

**Slice 6 (done): the host provider.** Vultr, gated by `npm run host-parity` —
14 steps. It is the first thing gated here that **no MCP tool reaches** and that
the native daemon does not serve either: `/api/hosts/*` is Phase 8. So it
follows the pattern `check-git-actions-parity.ts` already set for exactly this
case — run the TypeScript provider and the Rust one against their own loopback
stand-ins and diff both what each returned and every request it made, with the
Rust side reached through `examples/vultr-probe.rs`.

What the probing settled, and one thing it corrected:

- **One vendor word decides a machine's state, and `rawState` is that word.**
  Vultr spreads the answer over `status`, `server_status`, and `power_status`,
  and the first port modelled that as three inputs to one mapping. It is not:
  the subscription's lifecycle outranks everything, then `installingbooting` or
  `locked`, then power — and whichever field decided is the one reported. That
  is why `installingbooting` surfaces as `installing`, and why `server_status:
  "none"` falls through to power rather than meaning "provisioning".
- A machine with no label is shown by the hostname it answers to; an empty row
  is worse than a technical one.
- `0.0.0.0` is not an address. Vultr reports an address it has not assigned yet
  as that rather than as nothing.
- The status panel's credential half — the connection stripped to its `source`,
  and the account behind the key — is core. The `auth_error` / `connection_error`
  split and the ambient `{ source: "cli" }` fallback are the *route's* assembly
  and are **not** covered yet; they arrive with the route in Phase 8.

Two bugs in the gate itself, both of which invented divergences rather than
hiding them: `deepStrictEqual` counts `{ hostname: undefined }` — how the
reference builds an optional field — as different from an omitted key, so every
hostname-less instance failed over something no client could observe (it now
compares the serialised form, which is what anyone actually reads); and the
manifest, and with it the egress allowlist, is frozen at import time, so a
loopback base exported after the import left the reference refusing to reach its
own stub.

A fifteen-seed sweep catches all fifteen. One needed a better case first: "id
not encoded" survived because `reqwest` percent-encodes a space while parsing
the URL anyway, so a space proves nothing about explicit encoding. An id
containing `#` does — unencoded it truncates the path at a fragment.

**Exit gate:** write-lock tests, secret-redaction tests, provider fixture tests, and all domain parity cases pass without Node.js.

### Phase 5 — Agents, profiles, registry, and terminals

- Port agent environment discovery/editing, doctor checks, skill/MCP scope movement, and snapshots.
- Port local profile CRUD/apply/import/export and hosted registry authentication/transfer behavior.
- Port PTY/session ownership and external terminal reclaim semantics using a cross-platform Rust PTY layer.
- Port agent process orchestration and the approval broker into shared core services, even where the current MCP surface exposes only agent status. This is required for the later relay.
- Implement the remaining 24 MCP tools.

**Exit gate:** all 90 tools execute in Rust, the parity suite passes, and agent/terminal cleanup and approval-default-deny tests are green.

Eight agent-environment tools, ten profile tools, and the two gates behind them
have landed. What the probing settled, and three things it corrected:

- **The Codex config is rebuilt on every write, not edited.** The reference
  re-serialises the whole `mcp_servers` section from what it parsed, which has
  three effects that only a *file* comparison shows — the section is stably
  partitioned with stdio servers before remote ones (reordering entries that
  were already there), it moves below every other table in the file, and every
  key the reference has no field for is dropped: `startup_timeout_ms`,
  `bearer_token`, `http_headers`, and anything a user added. A `url` beside a
  `command` wins unless it is empty; an entry naming neither becomes
  `command = ""`. The first port had this as an alphabetical sort, and the
  agent-env gate — which was *written* to catch a sort, and plants
  `zz-ordered-last` ahead of `aa-ordered-first` to do it — passed anyway,
  because the sort no-opped on a freshly parsed document and only ran once a
  write in the same process had rebuilt the section. Discriminating on a first
  write is what the fixture now does.
- **`agents_add_mcp` and `profiles_apply` are one writer.** They were modelled
  as two, sorting and appending respectively; probed side by side against the
  same planted file they leave byte-identical results.
- **Only Antigravity reads `httpUrl`,** and there it outranks `url`, with the
  key that holds the URL standing in for the transport field it does not have.
- **Codex reads user skills from two directories** — `~/.agents/skills` then
  `~/.codex/skills`, each sorted internally, so the combined list is not sorted.
  Reading and writing are not symmetric: a skill is installed into the first but
  found in either.
- **A profile's servers are stored in a canonical shape,** rebuilt field by
  field: `kind, transport, url, headers, env` for a remote and
  `kind, command, args, env` for a local, with the other kind's fields dropped.
  A caller's own field order does not survive.
- **Export redacts by name only.** Five words — `token`, `secret`, `password`,
  `api_key`, `authorization` — matched against the whole normalised name or its
  last `_`-separated run. `API_KEY` is a secret and `PRIVATE_KEY` is not;
  `TOKENIZER`, `TOKENS` and `XTOKEN` are not; `Token` is and `tOkEn` is not,
  because normalisation is two camel-case splits before a fold rather than a
  fold. A token pasted into `PLAIN_VALUE` is exported in the clear.

The registry half — publish, install, and register-a-repository — is a
conversation, not a call, and only the *request* side shows it:

- **Publishing is five calls.** Look the slug up, create it when the lookup
  404s, create a version, upload the package, release it. A slug that already
  exists skips the create entirely, so a republish never updates its own title
  or summary. Each step names itself in a failure, because "HTTP 422" alone
  does not say which of the five went wrong.
- **What is uploaded is the redacted export**, and the version manifest carries
  less still: each server's name and kind, nothing else. Neither is a place a
  token can hide.
- **Installing is anonymous.** A public profile needs no token, so the tool
  never asks for one — and it downloads the package *before* it checks whether
  the local name is free, so a collision costs a round trip.
- **`download_url` is relative to the API base unless it names a scheme.**
- Sign-in is a file, and `NOMOREIDE_API_TOKEN` outranks it; the pre-rename
  `~/.brainctl/config.json` is a fallback that an empty current config does not
  reach past.

Two things the reference does that are worth changing on the TypeScript side
rather than only mirroring, and are called out here because parity forbids
fixing them in Rust alone:

- `profiles_import` does not check the `as` argument the way `create` checks a
  name. It is reduced to its last path segment, so `../escape` is contained —
  but `..` is its own last segment, and an import named `..` writes one level
  above the profiles root.
- The `.tar.gz` reader refuses a member path that would climb out, and is the
  only part of this domain that takes input nobody local wrote. It is worth
  keeping that way.

The terminal trio closes the ninety. They are the first tools whose subject is
not a file or a request but a live process, and that changed what the port and
the gate had to be:

- **The PTY manager already existed, in the desktop crate.** It moved to
  `nomoreide_core::terminal` rather than being written twice. Three things only
  showed up once something other than the desktop app read a session: it listed
  sessions straight out of a `HashMap`, so the order changed between two reads
  of the same registry; a session's argv could not carry a service's `env`; and
  an agent invocation could not pin a model. Insertion order is recorded now,
  and insertion and removal go through one method so nothing can put a session
  in the map but not in the order.
- **Ten refusal messages were missing their trailing period.** Harmless while
  they only reached the desktop UI, and exactly wrong once they became what a
  tool hands back verbatim.
- **`exit` is `{exitCode, signal}` with the signal as a number.** node-pty
  reports zero for a process that returned on its own. The Rust PTY layer
  reports a signal as a *localised name*, so a child that was killed cannot be
  given its number back without guessing at that name. Accepted divergence: a
  child that returned on its own — every case the tool surface can reach —
  reports zero on both sides.
- **A daemon-client URL builder percent-encodes every segment it is given,** so
  a collection two segments deep arrived as `terminal%2Fsessions` and reached
  nothing. The encoding is right for the *name* and wrong for the collection,
  which is now a separate argument.

The gate that holds them is `mcp:terminal-parity`. Two things about it are worth
carrying to any later gate over live state:

- **No tool creates a session,** so the gate drives each runtime's own
  `POST /api/terminal/sessions` — the same "state no tool creates" problem the
  deploy connections had, answered by using the endpoint that really does
  create it rather than by planting a file. A create that does not return 201
  fails the gate, because two runtimes that both failed to create a session
  would otherwise agree perfectly that it does not exist.
- **The id is the side channel.** A service terminal takes a stable
  `svc:<name>` id, so a service named `needs encoding#hash` produces an id that
  has to survive becoming a URL path segment; unencoded, the `#` truncates the
  request at a fragment. Three steps name that session and a fourth names the
  truncation, so a runtime that dropped the `#` gives the same answer to two ids
  that must differ.

What the gate deliberately does not reach: opening a *running* agent session
launches Terminal.app. The lease, the attach socket, and the
`terminalLaunching` presentation behind it cannot be exercised without taking
over the developer's desktop, and the core crate's own tests — which spawn real
PTYs against a stub socket — are what hold them instead. Every refusal in front
of that launch is compared, including the one needing a real agent session: a
stub provider binary that has already exited.

One environmental trap, because it costs an hour to rediscover: node-pty's
`spawn-helper` loses its executable bit, and every reference session then
reports `state: "error"`, `error: "posix_spawnp failed."`. The reference carries
a repair for exactly this. `chmod 755
node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper` before blaming a
port.

### Phase 6 — Dashboard, CLI, and Tauri convergence

- Serve the compiled React assets and compatible loopback API from the Rust daemon.
- Move CLI commands to the native client/core crates.
- Point the remaining Tauri commands at the shared daemon client. Because Phase 1 already removed Tauri's ownership of core modules, this is a call-site change rather than a manager replacement.
- Keep native-only desktop actions in Tauri, but make runtime state canonical in the daemon.
- Prove CLI, MCP, web, and Tauri observe the same service, terminal, and agent state.

**Exit gate:** the complete product runs on a machine with no Node.js installed. Node remains only a build-time dependency for frontend assets and tests.

**Exit gate met** by `scripts/check-no-node.sh`, which CI runs on every push. It drives the built binary with `node`, `npm`, `npx` and `tsx` absent from PATH and asserts 18 things: the daemon starts and mints its credential, twelve real GET routes answer 200, an unknown `/api` path still 404s (so a daemon answering everything with the SPA shell cannot pass by accident), the dashboard shell and its JS bundle are served, and `nomoreide mcp` lists its tools over stdio.

### Phase 7 — Native distribution and controlled cutover

- Extend release CI to build precompiled CLI archives for:
  - macOS arm64 and x86_64;
  - Linux x86_64 and arm64, with the libc strategy explicitly tested;
  - Windows x86_64 when the PTY/process suite is ready.
- Publish SHA-256 checksums and signatures with GitHub Release assets.
- Add `https://www.nomoreide.com/install.sh`; it detects OS/architecture, downloads the matching release, verifies its checksum, and installs to `~/.local/bin` or an explicit prefix.
- Make `nomoreide setup claude|codex|gemini` write native MCP entries.
- Update documentation to:

```bash
curl -fsSL https://www.nomoreide.com/install.sh | sh
claude mcp add --transport stdio nomoreide -- nomoreide mcp
codex mcp add nomoreide -- nomoreide mcp
```

- Keep the npm package for a deprecation window as a compatibility bootstrap/shim, not as the canonical runtime.
- Optionally publish a crate later for `cargo install`; crates.io distributes source and compilation, not the primary prebuilt artifacts.

**Exit gate:** fresh-machine installation, upgrade, downgrade, uninstall, checksum failure, PATH diagnostics, and all three MCP client setup flows pass without Node.js.

**Exit gate met** by `scripts/check-install.sh`, which CI runs on every push. It builds a release the way `.github/workflows/cli-release.yml` does — same archive layout, same `SHA256SUMS` — serves it over `file://`, and drives the real `apps/website/public/install.sh` through all of it: a fresh install, an upgrade, a downgrade, resolving "latest", a corrupted archive and an unlisted one (both refused with the working install untouched), an unwritable prefix, the PATH diagnostics including a shadowing binary earlier on PATH, and an uninstall that leaves the agent configs alone. It then runs all three setup flows off the installed binary with node absent from PATH and checks what each agent's config actually says.

**What shipped, and what did not:**

- **Targets.** macOS arm64 and x86_64, Linux x86_64 and arm64. Windows remains deferred, on this plan's own condition — the PTY and process suite is not ready for it.
- **libc.** The Linux archives are glibc, built on the oldest runner GitHub offers, and the `linux-compatibility` job runs the result in Ubuntu 22.04 and Debian 12 containers with no Node installed. That sets the floor at glibc 2.35. RHEL 9 and its rebuilds ship 2.34 and are **below** it. The fix is a musl build, which needs OpenSSL vendored because `reqwest` links it; that is a contained change but not one to make on the way out of a runtime refactor.
- **Signatures.** Sigstore build provenance through `actions/attest-build-provenance`, verifiable with `gh attestation verify --repo Rorogogogo/nomoreide`. No signing key exists for anyone to hold or lose. `install.sh` verifies the SHA-256 and does not require `gh`; the attestation is the stronger optional check.
- **Native setup.** `nomoreide setup <agent>` writes this binary's absolute path and `mcp`, and the `nomoreide-debug` skill is compiled into the executable so a downloaded binary with no package around it can still install one.
- **The npm package** stays published as a compatibility shim and now says so on a terminal, pointing at `install.sh`. The notice is suppressed when stderr is not a TTY, so an agent's MCP transport log and the parity gates never see it.

### Phase 8 — Remove the TypeScript runtime

- Run at least one stable native release with telemetry limited to version/health signals and opt-in diagnostics.
- Remove TypeScript daemon/MCP/core code only after the rollback window closes.
- Retain contract fixtures permanently as the public compatibility suite.
- Keep the React/TypeScript frontend source and build pipeline.

**Exit gate:** no production command or desktop path invokes Node.js, and the previous native release remains a documented rollback target.

**Not met, and it cannot be met inside a working session.** The first bullet
above is "run at least one stable native release", and the second is "remove
the TypeScript code only after the rollback window closes". Both are waiting on
wall-clock time after a release goes out, not on work. Deleting the TypeScript
runtime before that would also delete the differential parity gates, which are
the only thing that has been checking any of this.

**What has landed toward it:**

- **The host-provider bridge.** `host_provider_ssh_targets()` returned an
  explicit empty, so a native daemon listed a user's own SSH hosts and silently
  dropped every machine belonging to a connected provider. It now lists them,
  with the reference's rules: a provider that is down contributes nothing
  rather than blanking the page, and the 30-second cache exists because the
  servers view reloads on focus. `check-servers-parity` now connects the host
  fixture's provider, so its 112 cases actually exercise this — before, both
  runtimes agreed by both contributing nothing.
- **Six bugs in the Vultr instance mapping**, found by adding the fixture rows
  that no case had: `defaultUser` was the constant `"root"` where the vendor's
  `limited` scheme means `linuxuser`, `ipv6` was not reported at all, `::` was
  not recognised as "not assigned yet", a machine with neither label nor
  hostname came out unlabelled, and blank/zero vendor fields came out as `""`
  and `0` rather than absent.

**What is left, and what it is worth:**

- **`/api/hosts/*` is still unported — and nothing calls it.** No file under
  `apps/dashboard/src` references the path; the host surface reaches the user
  through `/api/servers` and the extensions manifest, both of which are ported.
  Porting six routes with no client is not what closes this phase, and saying
  so is more useful than a green tick beside dead surface.
- **The deploy provider surface is the real remaining gap**, because unlike the
  host routes it *is* reached by the dashboard. The daemon now serves the
  manifests plus the provider-neutral `projects` and `deployments` reads for
  Vercel and Cloudflare; `check-deploy-routes-parity.ts` holds those to 32
  response-and-vendor-request comparisons.
  `apps/dashboard/src/lib/api/provider-http.ts` still calls, per provider:
  `status`, `connect` (POST and DELETE), `oauth/start`, `oauth/status`,
  `scope`, `env`, `env/*`, and `project`. A native daemon therefore still
  renders most of the Deploy view's provider panel against missing endpoints.
  The OAuth pair is the hard part — it holds a login session in memory and
  serves an HTML result page — and it is why this was left for last rather
  than an oversight.
- **The compatibility suite needs a home that outlives the reference.** Every
  gate works by launching the TypeScript runtime and diffing; when Phase 8
  deletes it, all 66 stop being runnable. The fixtures are the durable half and
  the plan already says to keep them — but "retain contract fixtures" needs to
  become recorded expectations the native runtime is checked against on its
  own, and that conversion has not started.

## Suggested PR sequence

1. Contract snapshot and parity harness.
2. Repository layout cleanup (see `2026-08-20-repo-layout-cleanup.md`), landed before the workspace so the crates arrive in their final home.
3. Cargo workspace, `core/` lift out of `src-tauri`, config/state compatibility, daemon lock/auth.
4. Services/runtime vertical slice and MCP tools.
5. Git/GitHub/worktree/snapshot/onboarding slice.
6. Database/provider/error/docs slice.
7. Agent environment/profile/registry/terminal slice.
8. Dashboard/CLI/Tauri convergence.
9. Native release matrix and installer.
10. Default cutover, followed later by TypeScript runtime removal.

Every PR must keep the shipped TypeScript path working until PR 10.

## Validation matrix

- Rust: format, clippy with warnings denied, workspace tests, platform-target builds.
- Existing repository: `npm run lint`, `npm test`, `npm run build`, Tauri `cargo check` while TypeScript remains.
- MCP: initialize, list, and success/validation/error/safety fixtures for all 90 tools against both servers.
- State: TypeScript-to-Rust and Rust-to-TypeScript round trips during the compatibility window.
- Runtime: daemon discovery, stale-state recovery, duplicate daemon prevention, crash cleanup, and reconnect.
- Security: config redaction, path traversal, symlink races, command injection, database write lock, protected process termination, stdout protocol purity.
- Packaging: clean VMs/containers with no Node.js, upgrade/downgrade, checksum verification, and MCP client smoke tests.

## Cutover definition of done

- One installed `nomoreide` executable is sufficient.
- `nomoreide mcp` exposes the same 90 tools and schemas.
- Existing local data opens without loss or credential exposure.
- Web, CLI, MCP, and desktop share one Rust runtime.
- A fresh user can install with curl and configure Claude/Codex/Gemini without npm, npx, Python, or Node.js.
- The relay prerequisites—canonical service manager, agent run manager, approval broker, credential store, and outbound connector seam—exist in Rust.
