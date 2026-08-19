# Native Rust runtime and MCP migration plan

**Status:** Planning only. No implementation is authorized by this document.

**Goal:** Replace NoMoreIDE's Node.js runtime with one native `nomoreide` binary while preserving the current product behavior and the complete 90-tool MCP contract.

**Order:** This migration is the prerequisite for the remote-control relay. The relay must target the native Rust daemon, not add another dependency on the TypeScript daemon.

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

Create a root Cargo workspace while keeping `src-tauri` as a member:

```text
Cargo.toml
crates/
  nomoreide-core/       domain types, config, safety policy, shared services
  nomoreide-daemon/     machine-global runtime and loopback API
  nomoreide-client/     daemon discovery, authentication, typed client
  nomoreide-mcp/        stdio MCP protocol and 90 tool adapters
  nomoreide-cli/        the `nomoreide` binary and subcommands
src-tauri/              desktop shell using the shared client/core crates
```

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

Crate boundaries are architectural, not packaging boundaries. Do not ship five user-facing binaries.

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

- Create the Cargo workspace and the five crate boundaries above.
- Port config schemas, atomic filesystem helpers, redaction, path containment, and runtime-state types.
- Implement daemon discovery, lock ownership, health/version negotiation, and a mode-`0600` local credential.
- Add `nomoreide mcp` with initialization and `tools/list` from the frozen manifest; tool calls may return a typed `not_implemented` only on the development branch.
- Make Tauri depend on shared serializable types where practical, without changing runtime ownership yet.

**Exit gate:** the native binary starts on supported targets, lists the exact 90-tool contract, reads existing config safely, and cannot run beside another active daemon owner.

### Phase 2 — Canonical service runtime

- Port process management, service registry, service graph, logs, health, metrics, SSH service execution, Docker helpers, and bundles.
- Preserve argument-vector execution; never collapse structured commands back into shell strings.
- Implement the matching daemon API and the 13 service/runtime MCP tools.
- Port timeline/error recording needed by those tools.
- Add process-tree cleanup, restart, port-conflict, protected-process, and crash-recovery tests.

**Exit gate:** a clean-machine black-box suite produces equivalent service states, logs, health, and errors through TypeScript and Rust.

### Phase 3 — Git, GitHub, worktrees, snapshots, and onboarding

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
- Replace Tauri-owned process/log/agent managers with the shared daemon client.
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
2. Cargo workspace, config/state compatibility, daemon lock/auth.
3. Services/runtime vertical slice and MCP tools.
4. Git/GitHub/worktree/snapshot/onboarding slice.
5. Database/provider/error/docs slice.
6. Agent environment/profile/registry/terminal slice.
7. Dashboard/CLI/Tauri convergence.
8. Native release matrix and installer.
9. Default cutover, followed later by TypeScript runtime removal.

Every PR must keep the shipped TypeScript path working until PR 9.

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
