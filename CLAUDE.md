# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
cargo build -p nomoreide       # the binary: target/debug/nomoreide
cargo test --workspace         # the Rust suite
cargo clippy --workspace --all-targets -- -D warnings
npm run build        # Vite build of the dashboard → dist/web/client
npm run dev          # cargo run -p nomoreide --
npm run dev:web      # Vite dev server for the UI at localhost:5173 (proxies /api → localhost:4317)
npm test             # Vitest: the dashboard/website tests, and the parity harness support
npm run lint         # Biome over apps/dashboard/src, scripts, test (lint:fix to autofix)
npm run tauri:dev    # Tauri desktop app in dev mode (tauri:build to package)
```

**The product is a Rust binary**, `target/debug/nomoreide` in a checkout. There is no TypeScript server and no `dist/index.js` — what `npm run build` produces is the dashboard's static files, which the daemon serves.

**What CI gates.** `.github/workflows/ci.yml` runs `npm run build` + `npm test` across the Node matrix, and a `quality` job running the web client's type check and Biome. `vite build` does not typecheck, which is why the client check is its own step. To reproduce the `quality` job locally:

```bash
npx tsc -p apps/dashboard/tsconfig.json --noEmit   # client types; vite build does not typecheck
npm run lint
```

Lint is clean of *errors*; it reports warnings, and exits 0. Any error you see is yours. There is no root `tsconfig.json` — `scripts/` and `test/` run through tsx and are not typechecked, which is a real gap rather than an oversight to fix casually: making them typecheck means giving them the dashboard's path aliases, and the last attempt surfaced 139 pre-existing errors.

**The parity gates are discovered, not listed.** `ci.yml`'s `desktop-check` job also runs the Rust trio (`cargo fmt`/`clippy`/`test`) **but not the parity gates** — see the next paragraph for why they are a local gate. Each gate diffs what the native binary answers against a recording of what the TypeScript reference answered while it still existed, and `scripts/run-parity-gates.ts` finds them by globbing `scripts/check-*-parity.ts`. **So adding a gate means adding that file — there is no CI list to update**, and the runner fails the build if `package.json` names a gate the glob would miss. Run one during development with `npm run parity -- ./target/debug/nomoreide --only <fragment>`. Gates run one at a time on purpose: several at once produce timeouts that are contention rather than divergence.

**Two things about the toolchain and the recordings, both learned the hard way.** CI installs `dtolnay/rust-toolchain@stable` — whatever stable *is that day* — so a local toolchain that is a few releases behind runs a clippy that cannot see the lints CI fails on. `rustup update stable` before believing a green `cargo clippy`. And `test/expectations/` is committed: a recording must never become a picture of the machine that made it. Homes, workspaces, ports, the checkout, the user's home directory, and the gate's own pid are tokenised for you; anything else a gate mints goes through `volatile()`, and a body that carries machine state the gate does not compare — `/api/metrics?includeProcesses=1` answers with every process on the box — is trimmed at record time with `harness.redact(...)`.

**Replay is the only mode, because the reference is gone.** `src/` held the TypeScript implementation each gate diffed against; the port is finished and it has been deleted. `test/expectations/<gate>.json` — named after the script, so a gate needs no registration — is what the reference answered while it existed, and the recording now stands in for it. The runner refuses `--record` with that explanation, and `referenceSpec()` throws rather than letting a live run fail later as a puzzling ENOENT. **Recordings are a decaying regression asset:** when a deliberate product change invalidates one, first replace the behavior it protected with focused native Rust tests, then delete the gate script and recording. Do not add new recording gates. **The suite is a pre-merge local gate; CI does not run it.** A gate that needs something a machine does not have exits `3` and the runner calls it skipped (`--allow-skips` to let that pass) — `check-mcp-terminal-parity` does this where there is no Docker. Anything a gate mints that a recording must not keep — a stub's ephemeral port, a directory outside either runtime's tree — is registered with `volatile()` from `test/support/parity-recording.ts`; homes, workspaces, ports, the gate's own pid and the workspace version are already handled. **An answer that is a file on disk should not be recorded at all**: `check-shell-parity` compares the dashboard's own bytes against `dist/web/client`, because Vite content-hashes filenames and a recording of those froze one build — every rebuild then read as a divergence.

**Two release workflows fire on one tag.** The `v<version>` tag `deploy.yml` pushes starts both `desktop-release.yml` (the Tauri macOS dmg) and `cli-release.yml` (precompiled `nomoreide` archives for macOS arm64/x86_64 and Linux x86_64/arm64, plus a single `SHA256SUMS`). Both attach to the same GitHub Release. `cli-release.yml` refuses to publish a partial set — an installer that 404s on one architecture is worse than a release that never appeared — and gates the Linux archives behind a `linux-compatibility` job that runs the built binary in Debian 12, Ubuntu 22.04 and Rocky 9 containers. The Linux builds are **glibc, not musl**; the floor is the oldest runner GitHub offers, and it is tested rather than asserted. That `linux-compatibility` job earns its keep: `reqwest` used to build with native-tls, which links `libssl.so.3` dynamically, and a bare `debian:12` does not ship it — so the binary did not start at all there while `ubuntu:22.04` was fine. **`reqwest` is pinned to `default-features = false` plus `rustls-tls-native-roots` for that reason; do not restore its defaults.** Nothing in the workspace links OpenSSL now, which also means a musl build is no longer blocked on vendoring one.

**The archive layout is still load-bearing for installation metadata.** The dashboard is embedded in the binary at build time and needs no files beside it, but archives retain the `bin/nomoreide` and `share/nomoreide/web/client` prefix because `install.sh` and `check-install.sh` read `build-info.txt` there for version detection and uninstall. `apps/website/public/install.sh` (served at `https://www.nomoreide.com/install.sh`) unpacks that shape; `scripts/check-install.sh` builds a release exactly the way the workflow does, serves it over `file://`, and drives the real installer through install/upgrade/downgrade/uninstall, agent setup, a corrupted download, and PATH diagnostics. Run it with `npm run install-check` after `npm run build`.

**crates.io publishes from the tag, like npm.** `cli-release.yml`'s `crates` job publishes all eight crates in dependency order — `nomoreide-remote-protocol`, `nomoreide-core`, `nomoreide-daemon-client`, `nomoreide-actions`, `nomoreide-daemon`, `nomoreide-mcp`, `nomoreide-cli`, `nomoreide` — via `scripts/publish-crates.mjs`, which is resumable and skips versions already on the registry. It `needs` the same jobs npm does, so crates.io can never name a version the GitHub release lacks. Authentication is **trusted publishing**: `rust-lang/crates-io-auth-action` exchanges the workflow's OIDC identity for a ~30-minute token, so there is no secret — but like npm, that is configured **per crate** against this specific workflow file, so a new crate needs its trusted publisher added *before* the release that would publish it. The job builds the dashboard first because `nomoreide-daemon` vendors and compiles it in; skip that and the crate ships a daemon with no UI, which no local build would catch. Run it by hand with `node scripts/publish-crates.mjs --dry-run` — the five crates whose siblings are not yet on the registry report as skipped rather than failing, because cargo cannot package them until then. **`nomoreide-remote-protocol` has no trusted publisher yet** — it is new, and per the paragraph above that has to be configured before the release that would first publish it.

**Releasing is automatic, but opt-in per PR.** Label a PR `release:patch`, `release:minor` or `release:major` and merging it cuts that release; an unlabelled merge just accumulates on `main` (tested there by `ci.yml`). `gh workflow run deploy.yml -f bump=patch` still works, and the Actions tab does the same from a browser. A PR carrying two release labels takes the larger bump. The `decide` job in `deploy.yml` reads the label through the environment rather than `${{ }}` interpolation, because a label is attacker-controllable text on a fork's PR. Whichever way it starts, that job bumps the version and tags `v<version>`; **the tag push is what triggers** `desktop-release.yml` (the dmg and the GitHub Release) and `cli-release.yml` (archives, then npm, then crates.io). The release notes come from the body of the PR behind the tag's parent commit (`## Release note` preferred, with `###` subheadings — a `##` ends the section — see `.github/pull_request_template.md`).

**npm ships the Rust binary, and `deploy.yml` does not publish it.** It cannot: the package carries a compiled binary for four platforms and none of them exist when the tag is pushed — pushing the tag is what starts the build. So `cli-release.yml` publishes npm from the same tag, in a job that `needs` the archives, which means npm can never name a version whose binaries are missing. The published `nomoreide` is a **shim** (`npm/nomoreide/bin/nomoreide.js`) whose `optionalDependencies` are `@nomoreide/cli-{darwin-arm64,darwin-x64,linux-x64,linux-arm64}`; each declares its `os`/`cpu`, so npm installs exactly one and the shim execs it. `scripts/build-npm-packages.mjs` builds all five from the release archives, reproducing the archive layout (`bin/` beside `share/nomoreide/web/client`) so `asset_roots()` finds the dashboard with no Rust change. The root `package.json` is `private` and is not what gets published. **Platform packages publish before the shim** — the shim pins them at an exact version, so the other order leaves a window where `npm install -g nomoreide` resolves a shim whose binary package does not exist. Publishing uses npm **trusted publishing** (OIDC via `id-token: write`), so there is no token anywhere; that is configured per package against a specific workflow file, so all five must be pointed at `cli-release.yml`, and a new platform package needs that done before its first publish or the job fails at the end of a release.

## Architecture

NoMoreIDE is an AI-native service workbench exposing three UI modes (CLI, TUI, web dashboard) and an MCP server for AI agents. All of them share one core, and **all of it is Rust**: a Cargo workspace under `crates/`, built into a single `nomoreide` binary that runs with no Node.js on the machine (asserted by `scripts/check-no-node.sh` in CI). The dashboard is the one part that is not Rust — it is a React app that a browser runs, built by Vite and served as static files.

There was a TypeScript implementation of everything below, under `src/`. It is gone. It existed as the reference the parity gates diffed the port against, and deleting it was the point of the port finishing — see the record/replay paragraphs above for what that means for the gates.

### The crates

| Crate | What it is |
| --- | --- |
| `nomoreide-remote-protocol` | The frozen relay wire format — `serde`, `serde_json`, `chrono` and nothing else. Its own package because the hosted platform speaks it too, from a different repository, and `nomoreide-core`'s dependency tree has no business in an API container. Re-exported as `nomoreide_core::remote::protocol`. |
| `nomoreide-core` | The backbone and every feature module — config, processes, logs, git, agents, databases, providers. The biggest by far. |
| `nomoreide-daemon` | The HTTP server on `127.0.0.1:4317`: route registry, static assets, streams. |
| `nomoreide-daemon-client` | The thin HTTP client every front door uses, plus daemon discovery/spawn (`lifecycle.rs`). |
| `nomoreide-mcp` | The stdio MCP server and its tools, grouped by domain in `src/tools/<domain>.rs`. |
| `nomoreide-actions` | The guarded write surface — the operations deliberately kept out of the read-safe modules. |
| `nomoreide-cli` | Argument parsing and the subcommands, as a library. **No binary** — two crates emitting `nomoreide` collide in `target/`. |
| `nomoreide` | The binary everything ships as — a front door over `nomoreide-cli`, and the name `cargo install` takes. |
| `nomoreide-tauri` | The desktop app. Deliberately isolated — it owns its own runtime state and shares no daemon. Its 150 duplicate commands are known debt with a plan — and the reason agent-environment is a desktop stub rather than a feature: `docs/plans/2026-09-01-desktop-in-process-daemon.md`. |

### Core

The stateful backbone in `nomoreide-core`:

- **Config** (`config.rs`, `config_files.rs`) — persistent config at `~/.config/nomoreide/config.json`. Service definitions (command, cwd, port, env), bundles, git repos.
- **ProcessManager** (`process_manager.rs`) — spawns services, watches health/URLs in stdout, checks a port is free first. **Only kills what it spawned**; a foreign process on a conflicting port is reported, never terminated.
- **Log store** — in-memory ring buffer per service plus an append-only file at `.nomoreide/logs/{service}.log`.
- **Git** (`git_manager.rs`) — read-safe by construction; it has no `reset --hard`, `clean`, force-push or `branch -D`. Takes an arbitrary `cwd`, so it works against any repo.
- **Health and ports** (`service_health.rs`, `port_utils.rs`).

Around that sit the feature modules. Two exist specifically to keep dangerous operations out of the read-safe ones — **respect the split rather than adding writes to the read side**:

| Read-safe (agent-reachable) | Write-capable (guarded) |
| --- | --- |
| `git_manager.rs` | `nomoreide-actions/src/git.rs` — push/commit/squash-merge |
| `db/peek.rs` | `nomoreide-actions/src/db.rs` — human-only, per-connection unlock, affected-rows preview |
| `vercel_manager.rs` | `vercel_actions.rs` — redeploy/cancel/promote/rollback, dashboard-only, no MCP tools |

### The shared daemon

One detached, machine-global daemon (`nomoreide daemon`, state at `~/.nomoreide/daemon.json`) owns every spawned service — it **is** the web server on `127.0.0.1:4317`. MCP, CLI and TUI are all thin HTTP clients of it. `DaemonClient::ensure` reuses a healthy one (state file + live pid + `/api/health` + matching owner id), adopts one it did not start, or spawns one by re-executing `current_exe()` with `daemon`. **Every path that acts on the runtime uses `ensure`; only `daemon status` and `daemon stop` use bare discovery**, because starting a daemon to report that none is running would be a lie and starting one to stop it is worse — so services survive a session exiting and are visible from every front door at once. Two sessions racing both spawn; the loser fails to bind and exits, and its poll adopts the winner. `nomoreide daemon {status,stop,restart}` manages it; `stop` stops all services. **The Tauri app is deliberately outside this** — it owns its own `ProcessManager` and shares no runtime state, so a service started in the desktop app is invisible to the CLI and vice versa. That isolation is the decision; the duplicate command surface it currently implies is not, and `docs/plans/2026-09-01-desktop-in-process-daemon.md` resolves it by hosting the daemon inside the app rather than sharing one.

The daemon prefers dashboard files on disk and falls back to the copy embedded at compile time, so **a client-only checkout change needs `npm run build` plus a browser refresh; rebuilding the embedded copy needs `cargo build -p nomoreide`; a server change also needs `nomoreide daemon restart`** (which stops running services). Disk-first lookup lets a fresh Vite build take effect without recompiling Rust. Published `nomoreide-daemon` crates carry a vendored client fallback staged through `OUT_DIR` by `build.rs`.

### MCP server

A stdio MCP server for AI agents (Claude Code, Codex CLI, Gemini CLI, Cursor, and Windsurf), exposing 70+ tools. Service-runtime tools (start/stop/logs/status/timeline) go to the daemon over HTTP; config/git/db/agent tools run in-process. Tools are grouped by domain in `nomoreide-mcp/src/tools/<domain>.rs` — **adding a tool means editing its domain module, never growing a per-tool branch in an aggregator.** Everything is read-safe or scoped to services registered in config; there is no raw filesystem enumeration.

`nomoreide setup <claude|codex|gemini|cursor|windsurf>` registers the server by writing the agent's own config, recording the **absolute path of the running binary** (`native_server_command()` in `agent_profiles/debug_setup.rs`) — absolute because an agent launched from a desktop session does not inherit your shell PATH, and symlinks deliberately unresolved so a versioned-directory install keeps working across upgrades. `install.sh` runs this for every agent it detects.

### Web layer

The HTTP server in `nomoreide-daemon/src/server/`. A thin dispatcher matches each request against a **route registry** under `routes/`, one module per domain. **Adding an endpoint never edits the dispatcher** — add or extend a route module and register it. The React frontend (`apps/dashboard/src/`) is Vite + React 19 + Tailwind 4 + Radix + Framer Motion, one directory per feature under `features/`.

### CLI and TUI

`nomoreide-cli` routes to each mode. Subcommands: `mcp`, `setup`, `tui`, `web`, `daemon`, `git`, `db`, `agents`, `profile`, `list`, `logs`, `start`, `stop`, `restart`, `add`.

### Data flow

```
AI agent ──stdio──► MCP server ──┐
User ────► CLI / TUI / browser ──┼── HTTP 127.0.0.1:4317 ──► Daemon (the web server)
                                 │                            Core
             (config writes go straight to the config store;  (config / process / log / git)
              the daemon re-reads config from disk per op)         │
                                                              Managed processes
```

### Remote control

A phone drives a paired machine through the hosted platform. The daemon dials
**out** over TLS and holds one socket; nothing listens on the user's machine and
no port is opened. The wire format is `nomoreide-remote-protocol` — its own
published crate, because `../nomoreide-platform` speaks the same protocol and
cannot depend on `nomoreide-core`. `docs/remote-protocol-v1.md` is the contract,
`docs/remote-control-operations.md` is what to do when it misbehaves.

Three rules that are easy to erode and expensive to lose:

- **The dispatcher routes through the daemon's own router**, in-process, against
  `ALLOWLIST` in `nomoreide-daemon/src/remote/dispatcher.rs`. It does not call
  core directly. That table is the gate, checked before the match, and the
  advertised capability set is read off it — so a command cannot be routable
  without being advertised or the reverse. Adding a remote capability means
  adding a row, not adding a branch somewhere.
- **Wire types have nowhere to put what must not leave.** A `RemoteService` has
  name, description, kind, port, state — no command, cwd, env, pid, container or
  ssh host. The reshaping in the dispatcher is where those are dropped, and a
  test renders the answer and greps for each of them.
- **Nothing retries a mutation.** A timeout says nothing about whether the
  machine did the work. Not in the hub, not in the connector, not in the
  frontend's mutation hooks.

Two kill switches, independent on purpose: `REMOTE_RELAY_ENABLED=false` on the
platform (the routes are *unmounted*, so it 404s rather than refusing), and
`NOMOREIDE_REMOTE_DISABLED=1` on one machine. Neither revokes anything —
revocation is the owner's, it writes the row before closing the socket, and it is
one-way.

**The relay is its own process**, `nomoreide-platform`'s `relay` binary — the
device sockets are not in the API. Presence is in memory, so whatever holds a
socket is single-replica and should almost never restart, and that is the
opposite of what a public catalogue wants; while they shared a process every
registry deploy dropped every machine's socket. The edge proxy routes
`/remote/ws/device` to the relay, so the daemon's URL is unchanged. The daemon
cannot tell the difference, and nothing in this repository had to change for it.

## Key Patterns

- **serde everywhere**: config and MCP tool inputs are typed and validated on the way in. `serde_json` is built with `preserve_order` and **must stay that way** — a JSON object's keys are sometimes the user's own data (the MCP servers in a profile), and the reference preserved insertion order.
- **XDG-compliant**: global config in `~/.config/nomoreide/`, project logs in `.nomoreide/logs/`.
- **MSRV 1.77.2**, and CI installs whatever `stable` is that day — so a green local clippy proves nothing if your toolchain is behind, and a newer-than-MSRV method (`is_none_or`) is a hard error. `rustup update stable` first.
- **Test isolation**: Rust tests and the parity gates use temp-directory fixtures; the Vitest files under `/test/` cover the dashboard, the website, and the parity harness.
- **i18n (en + zh)**: user-visible strings go through `useT()` (`lib/i18n/`). `en.ts` is the source of truth and defines `TranslationKey`; `zh.ts` is a `Partial` map, so **a key missing from zh silently renders English rather than failing any build** — add both sides in the same change.
- **Dual license**: AGPL-3.0 for open source, commercial license for proprietary use (see `COMMERCIAL.md`).

## Expandability (keep it modular as it grows)

The project is meant to grow feature-by-feature, so new work should land as a **vertical slice**, not edits scattered across god-files:

- A feature = `nomoreide-core/src/<feature>.rs` (logic) + `nomoreide-daemon/src/server/routes/<feature>.rs` (HTTP) + `nomoreide-mcp/src/tools/<feature>.rs` (agent surface, where relevant) + `apps/dashboard/src/features/<feature>/` (UI). Wire it up at the registry/module, don't grow a central switchboard.
- **Soft size budgets** (a refactor *smell*, not a CI hard-fail): ~300 lines/file, ~50 lines/function. When a file crosses it, split by responsibility — extract React data-fetching into hooks and sub-sections into their own components; group server routes/MCP tools by domain. Large core modules (`process_manager.rs`, `git_manager.rs`) are acceptable but watch their growth.
- Keep generic dispatch/routing **feature-agnostic**; feature specifics live in the feature's own module.
- Respect the existing safety boundaries: `git_manager.rs` stays read-safe (destructive ops belong in `nomoreide-actions`), and app features needing external data (Linear/DB/GitHub) hold **their own** credential/driver — they can't borrow the agent's MCPs.
- **Mirror every new endpoint in the website mock.** The marketing site (`apps/website/`) embeds the *entire* live dashboard (`WorkbenchApp`) and stubs all `/api/*` calls through `apps/website/src/mock-api.ts`. So when a feature adds an endpoint that a view **reads on mount** (anything where the API seam returns `res.<field>`), add a matching handler with demo data to `mock-api.ts` — otherwise the request hits the default `{ ok: true }` fallback, the seam hands the UI `undefined`, and a field/array access during render white-screens the embedded app. Click-action endpoints that only return `{ ok }` don't need one. The mock's fallback `console.warn`s any unhandled `/api/*` path in dev — watch the console when running `npm run dev --workspace @nomoreide/website`.
