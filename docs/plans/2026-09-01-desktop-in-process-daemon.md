# Desktop app: one implementation, still self-contained

**Status:** planned, not started. Decided 2026-09-01.
**Supersedes:** the Tauri convergence bullets in Phase 6 of
`2026-08-20-native-rust-runtime-and-mcp.md`.

## The decision

The desktop app **stays self-contained**. A user downloads one `.dmg` and needs
nothing else — no Node, no separate binary, no install step, no network, and no
daemon shared with anything outside the app.

It should **stop being a second implementation**. Today it is both: self-contained
*and* duplicated.

Those are separable, and conflating them is what this plan corrects. The shared
daemon was rejected — correctly — but the daemon is not an external dependency:
`ensure_daemon` re-executes `current_exe()`, so it is this binary in another
mode. The desktop app can host it **in its own process**, on a loopback port
that lives and dies with the window.

That is *more* self-contained than today (one process, nothing to orphan) while
deleting the duplicate.

## Why it is worth doing

**The duplication is large and already drifting.**

| | Measured 2026-09-01 |
| --- | --- |
| Tauri commands | **150**, across 18 modules in `crates/nomoreide-tauri/src/commands/` |
| Tauri command code | **7,555 lines** |
| Desktop-only frontend API impls | **18 files, 1,396 lines** (`apps/dashboard/src/lib/api/*-tauri.ts`) |
| HTTP API modules they duplicate | 62, already shipped in the browser |

**The cost is not hypothetical — agent-environment is the worked example.**
The desktop app renders that page as an empty state. `agent-env-tauri.ts` is a
deliberate stub whose every method returns nothing or rejects with "not
available in desktop mode yet", and whose comment gives the reason: *"the Rust
core has no agent-config readers yet (deliberate: ROR-60 defers the dual-backend
port)."*

**That reason has since expired.** `nomoreide-core/src/agent_env/` now has the
readers, writers, documents and skills — it is what gained Cursor and Windsurf
on 2026-09-01. So the feature is not blocked on core any more; it is blocked on
someone writing **27 more Tauri commands**, one per method on `AgentEnvApi`, on
top of the 150 that already duplicate the daemon.

That is the duplication tax quoted in advance for a single feature, and it is
what this plan removes: with the daemon in-process the stub is deleted and the
page works, because it is the same dashboard against the same routes. Phase 1 of
the original plan warned about it — *"three concurrent implementations … with the
Tauri copy drifting the whole time."* Two are gone; this is the third.

**The replacement is not new code.** The 62 HTTP modules already exist, ship in
the browser, and are what CI and the 65 parity gates exercise. This moves the
desktop app off the untested path onto the tested one, and deletes **~8,950
lines** rather than writing any.

## Target architecture

```
Tauri process
├── nomoreide_daemon::run(port = <ephemeral>)   ← in-process, loopback only
│     └── the same routes, streams and dashboard the browser gets
├── webview → http://127.0.0.1:<port>
└── native-only Tauri commands (dialogs, tray, shell, window)
```

- The port is **ephemeral and private**. It is not `4317`, so the app deliberately
  does not see CLI- or MCP-started services. That isolation is the decision, kept.
- The daemon task is owned by the app and ends with it. Nothing survives quit.
- `~/.config/nomoreide/config.json` stays shared — *definitions* are common,
  runtime state is not, exactly as today.

## Current state, with the facts a fresh session needs

- `crates/nomoreide-tauri/Cargo.toml` depends on `nomoreide-core` and
  `nomoreide-actions`, **not** `nomoreide-daemon`. Adding it is one line.
- `crates/nomoreide-tauri/src/lib.rs:22-51` builds `AppState { config_store,
  log_store, process_manager, terminal_manager, database_exports }` and
  `ProcessManager::new(...)` at line ~44. This is what goes away.
- `crates/nomoreide-tauri/src/event_sink.rs` is **26 lines** implementing
  `nomoreide_core::event_sink::EventSink` over `AppHandle::emit`. Events are
  already abstracted in core, so the daemon has its own sink for the same trait —
  check how the daemon streams before assuming a rewrite is needed.
- `crates/nomoreide-tauri/tauri.conf.json` sets
  `frontendDist: "../../dist/web/client"` and `devUrl: "http://127.0.0.1:5173"`.
- The frontend seam is per domain, e.g. `apps/dashboard/src/lib/api/agent-chat.ts`:
  ```ts
  const api: AgentChatApi = isTauri() ? tauriAgentChatApi : httpAgentChatApi;
  ```
  `isTauri()` comes from `apps/dashboard/src/lib/api/tauri-bridge.ts`.
- The daemon entry point is `nomoreide_daemon::run(DaemonOptions { port, .. })`
  (see `crates/nomoreide-cli/src/lib.rs`, `run_foreground_daemon`).
- Auth: `require_credential` in `crates/nomoreide-daemon/src/server/app.rs:177`
  guards the router assembled in `routes.rs:179`, comparing a Bearer token in
  constant time. The shell/asset routes sit **outside** it deliberately, because
  a document load cannot send a header.

## Slices

Each slice ends green. Do not start the next until it is.

### Slice 1 — the daemon runs inside the app

1. Add `nomoreide-daemon = { path = "../nomoreide-daemon", version = "…" }` to
   `crates/nomoreide-tauri/Cargo.toml`.
2. In `run()`, before building the window, bind an **ephemeral** loopback port
   (`TcpListener::bind("127.0.0.1:0")`, read the port, drop the listener — or
   better, teach `DaemonOptions` to accept a pre-bound listener and avoid the
   race entirely).
3. Spawn `nomoreide_daemon::run` on the Tauri async runtime, keeping its
   `JoinHandle` in state so quit can abort it.
4. Poll `/api/health` until it answers, with a timeout, **before** the window
   loads. A window that opens against a daemon that has not bound yet shows a
   blank page, and that is the single most likely bug in this whole plan.
5. Leave every existing Tauri command in place. Nothing is deleted yet.

**Verify:** the app launches, behaves exactly as before, and
`curl http://127.0.0.1:<port>/api/health` answers while it runs and refuses once
it quits. Confirm no process survives quit.

### Slice 2 — decide how the webview authenticates

This is the one genuinely open question, and it must be answered before any
frontend change.

- Determine what the daemon requires of the webview for the routes behind
  `require_credential`.
- **Do not test this against a running daemon on 4317 without checking its
  version.** During planning, that daemon was **v0.1.103** — an old build whose
  auth behaviour is not evidence about current code.
- Options, in order of preference:
  1. The app reads `state.credential` directly (same process) and injects it
     into the webview before first paint — e.g. Tauri's init script setting a
     global the HTTP client reads.
  2. The shell route already serves the page unauthenticated; if it can also
     carry the credential to the page the way the browser flow does, reuse that
     path rather than inventing a second one.
- Whatever is chosen, the credential must not be written to disk or logged.

**Verify:** a gated route (`/api/git/status`, `/api/terminal/*`) succeeds from
the webview and fails without the credential.

### Slice 3 — point the webview at the daemon

1. Load the window from `http://127.0.0.1:<port>` instead of the bundled
   `frontendDist`. The daemon already serves the dashboard — it is **compiled
   into `nomoreide-daemon`** (`build.rs` → `EMBEDDED_DASHBOARD`), so no files
   are needed beside the app.
2. Keep `frontendDist` populated if Tauri's bundler insists on a path; it stops
   being what the window loads.
3. Check Tauri's CSP and `dangerousRemoteDomainIpcAccess`-style settings — a
   window on `http://127.0.0.1` is a different origin from `tauri://localhost`,
   and native `invoke()` from that origin may need explicit allowance. If any
   native command is still needed in slice 5, this matters.

**Verify:** the full dashboard renders in the desktop app, including a page the
desktop app never had — **agent-env is the proof**, since it does not exist in
the Tauri command surface at all.

### Slice 4 — retire the duplicate

1. Make `isTauri()` stop selecting the Tauri implementations (or delete the
   branch outright).
2. Delete the 18 `apps/dashboard/src/lib/api/*-tauri.ts` files and collapse each
   `<domain>.ts` selector to the HTTP implementation.
3. Delete the 150 `#[tauri::command]` functions under
   `crates/nomoreide-tauri/src/commands/` **except** those in slice 5.
4. Delete `AppState`'s `config_store`, `log_store`, `process_manager`,
   `terminal_manager`, `database_exports` — the daemon owns all of it now.
5. Drop `nomoreide-actions`, `sqlx`, `portable-pty` and friends from the Tauri
   manifest if nothing there still uses them.

**Verify:** `cargo clippy --workspace --all-targets -- -D warnings`,
`cargo test --workspace`, `npx tsc -p apps/dashboard/tsconfig.json --noEmit`,
`npm test`, and a manual pass over the desktop app's main flows.

### Slice 5 — keep what is genuinely native

Audit the 150 before deleting. Anything that is not data — dialogs, tray, window
control, `tauri-plugin-shell`, opening a path in Finder — **stays** a Tauri
command. Only the data commands that duplicate an HTTP route go.

## Risks and traps

- **Blank window on a race.** The largest risk. The window must not load before
  the port is bound. Prefer handing the daemon a pre-bound listener over polling.
- **Startup failure needs a real error.** If the daemon cannot start, the user
  must see a message, not an empty window. There is no terminal to read.
- **The trust boundary changes.** Tauri IPC is OS-level; loopback HTTP is guarded
  by the daemon's bearer token. Any other local process could reach the port, so
  the credential is what matters — do not skip slice 2 or weaken the check.
- **Streams.** Terminals and logs must keep working. Core already abstracts
  events (`EventSink`); confirm the daemon's SSE path covers every event the
  Tauri sink emitted before deleting `event_sink.rs`.
- **Do not touch the archive layout or `install.sh`.** They are unrelated and
  currently green (`npm run install-check` → 53/53).
- **Parity gates do not cover the desktop app**, so they will stay green through
  a regression here. Manual verification is the gate.

## Exit gate

- The desktop app ships as one `.dmg`, needs nothing external, and leaves no
  process behind on quit.
- Its dashboard is the same one the browser gets, including agent-env.
- `crates/nomoreide-tauri/src/commands/` holds only genuinely native commands.
- `apps/dashboard/src/lib/api/*-tauri.ts` is gone, and no `isTauri()` branch
  selects an API implementation.
- ~8,950 lines lighter, with `cargo clippy -D warnings`, `cargo test
  --workspace`, `tsc`, `npm test` and the 65 parity gates all green.

## What this plan explicitly does not do

- It does **not** make the desktop app share a daemon with the CLI, MCP or
  browser. That was considered and rejected; the isolation is deliberate.
- It does **not** change the release, install or npm paths.
- It does **not** add a runtime dependency of any kind.
