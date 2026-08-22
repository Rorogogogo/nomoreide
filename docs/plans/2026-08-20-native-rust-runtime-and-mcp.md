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

Two behaviours are carried over verbatim rather than reconciled, and belong to
the parity pass below: `pull_default` still uses `checkout` and swallows its
error where the TypeScript `checkoutDefaultAndPull` uses `switch` and reports
one, and the Rust `default_branch` has no fallback to a local `main`/`master`
when `origin/HEAD` is unset.

- Extract/port the existing Rust Git/Tauri work, then fill gaps against the TypeScript reference.
- Port GitHub authentication and API operations without changing credential precedence.
- Port snapshots, repository selection, worktree management, context assembly, and onboarding.
- Implement the 35 MCP tools in these domains and their guarded write cases.

**Exit gate:** parity fixtures cover clean/dirty repositories, detached HEAD, remotes, worktrees, PR/issue errors, and snapshot restore boundaries.

### Phase 4 — Databases, providers, errors, and documentation

- Port database registration, catalog inspection, sampling, masking, and guarded queries.
- Support the same database engines and URL redaction behavior as today.
- Port the provider registry and Vercel/Cloudflare/Vultr HTTP behavior used by MCP and dashboard APIs.
- Port error inbox/prompt generation and embedded documentation/UI lifecycle tools.
- Implement the 18 MCP tools in these domains.

**Exit gate:** write-lock tests, secret-redaction tests, provider fixture tests, and all domain parity cases pass without Node.js.

### Phase 5 — Agents, profiles, registry, and terminals

- Port agent environment discovery/editing, doctor checks, skill/MCP scope movement, and snapshots.
- Port local profile CRUD/apply/import/export and hosted registry authentication/transfer behavior.
- Port PTY/session ownership and external terminal reclaim semantics using a cross-platform Rust PTY layer.
- Port agent process orchestration and the approval broker into shared core services, even where the current MCP surface exposes only agent status. This is required for the later relay.
- Implement the remaining 24 MCP tools.

**Exit gate:** all 90 tools execute in Rust, the parity suite passes, and agent/terminal cleanup and approval-default-deny tests are green.

### Phase 6 — Dashboard, CLI, and Tauri convergence

- Serve the compiled React assets and compatible loopback API from the Rust daemon.
- Move CLI commands to the native client/core crates.
- Point the remaining Tauri commands at the shared daemon client. Because Phase 1 already removed Tauri's ownership of core modules, this is a call-site change rather than a manager replacement.
- Keep native-only desktop actions in Tauri, but make runtime state canonical in the daemon.
- Prove CLI, MCP, web, and Tauri observe the same service, terminal, and agent state.

**Exit gate:** the complete product runs on a machine with no Node.js installed. Node remains only a build-time dependency for frontend assets and tests.

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

### Phase 8 — Remove the TypeScript runtime

- Run at least one stable native release with telemetry limited to version/health signals and opt-in diagnostics.
- Remove TypeScript daemon/MCP/core code only after the rollback window closes.
- Retain contract fixtures permanently as the public compatibility suite.
- Keep the React/TypeScript frontend source and build pipeline.

**Exit gate:** no production command or desktop path invokes Node.js, and the previous native release remains a documented rollback target.

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
