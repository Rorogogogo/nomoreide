# 90/90 tools native — Phase 5 tool surface is complete

## Read this first

`docs/plans/2026-08-20-native-rust-runtime-and-mcp.md`, the **Phase 5** section.
It is the memory of this refactor and the only part of it in version control.
The terminal findings were appended there this session. Read it before writing
any Rust.

`handoffs/probe/terminal-findings.md` holds the raw probe output the terminal
port was built from, and `handoffs/probe/terminal-probe.ts` /
`terminal-shapes-probe.ts` re-run it (set `NMI_CANDIDATE=./target/debug/nomoreide`
to point the first at the native binary instead of the reference).

## State

**All 90 tools of the frozen manifest are native.** Committed, NOT yet pushed.

- `81857cb test(mcp): assert every frozen tool is served natively`
- `b5c1b02 test(terminal): close the two holes the seeded sweep found`
- `5f15137 test(mcp): gate the terminal tools against the reference`
- `22fd0d2 feat(mcp): serve the terminal trio from the daemon`
- `a5913e3 refactor(terminal): move the PTY manager into shared core`

Green as of this session:

- 16/16 parity gates, including the new **terminal (29 steps)**
- full `cargo test --workspace`, 48 terminal tests in core
- 1808/1808 vitest (235 files), `npm run build`, dashboard tsc, biome,
  `version:check`, `rust:dependency-check`

**Gate invocation is not uniform — this cost time:**
- most: `npm run mcp:<name>-parity -- ./target/debug/nomoreide`
- surface: `node --import tsx scripts/check-mcp-parity.ts -- ./target/debug/nomoreide mcp`
  (the `mcp` subcommand must be explicit, and npm doubles the `--`)
- `host-parity` and `git-actions-parity` take a **probe example binary** and
  default correctly with **no argument** — run `cargo build --examples` first.

## Seeded sweep

22 seeds, 22 caught. First pass 15 → 13 caught, 2 holes:
- *a stable id that stopped reattaching* is invisible to the tool surface (a
  replacement renders an identical payload; only the pid differs). Closed with a
  core unit test, not a gate step.
- *the create endpoint answered for nobody* — the gate leaned on
  `POST /api/terminal/sessions` without comparing what it said. Closed by
  comparing its answers; re-swept with 7 seeds, all caught.

`/tmp/seed_sweep.py` and `/tmp/seed_sweep2.py` are gone with the tmpdir. If you
re-sweep, note the trap that bit here: the sweep restores with
`git checkout -- crates/`, which **silently reverts uncommitted work in
`crates/`**. Commit first, or restore per-file. End every sweep with `cargo
build` (memory `rebuild-after-a-seeded-sweep`).

## Another agent is writing in this tree, right now

`git status` shows an in-progress **git-search feature** that is not mine:
`crates/nomoreide-core/src/git_manager/search.rs` (untracked),
`git_manager/{mod,types}.rs`, `crates/nomoreide-daemon/src/server/routes/git.rs`,
`crates/nomoreide-tauri/src/commands/git.rs`, and several
`apps/dashboard/src/features/git/` files. **Do not commit any of it.** Stage
explicitly, never `git add -A` (and never `git add .`); `handoffs/` must also
stay out of every commit.

Their `search.rs` currently fails `cargo clippy --workspace -- -D warnings` on
an MSRV lint (`is_none_or` is 1.82, workspace MSRV is 1.77.2). That failure is
theirs, not a regression from the terminal work — clippy over the four crates I
touched was clean before their file appeared.

## What is left in Phase 5

The tool surface is done; the phase's exit gate is not:

- **Agent process orchestration and the approval broker** in shared core
  services. Required for the later relay, and no MCP tool exposes them, so this
  needs the same "state no tool creates" treatment the terminal gate got.
- **Bundled-plugin apply** — still deferred. TS `plugin-apply.ts` is 507 lines
  and the current fixture cannot produce a bundled plugin.

Carried forward, unchanged:

- **Accepted divergence — `profiles_import` with `as: ".."` can write above its
  root.** Mirrored rather than fixed; needs a joint TS+Rust change (memory
  `profiles-import-can-write-above-its-root`).
- **Accepted divergence — a signalled terminal child's `signal` number.** The
  Rust PTY layer reports a signal as a localised *name*. A child that returned
  on its own reports `signal: 0` on both sides, which is every case the tool
  surface reaches.
- **Not gated — opening a *running* agent session** launches Terminal.app. The
  lease and attach socket behind it are held by core's own tests instead.

## Standing user rules — do not relitigate

- *"no pr until the refactory is 100% finished and tested bro"* — no
  `gh pr create` on this branch at any point.
- *"now I think it's ok to push just dont pr is ok"* — pushing is authorized.
- Never `git stash` in this tree (parallel writers — see above).

## Push recipe

```
NMI_TOKEN="$(gh auth token)" git \
  -c credential.helper= \
  -c credential.helper='!f() { echo username=x-access-token; echo "password=$NMI_TOKEN"; }; f' \
  push origin rust-refactoring 2>&1 | sed -E 's/gh[pous]_[A-Za-z0-9]+/[redacted]/g'
```

## Environment trap

node-pty's `spawn-helper` loses its executable bit, and every reference terminal
session then reports `state: "error"`, `error: "posix_spawnp failed."`. Fix with
`chmod 755 node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper` before
blaming a port. An `npm ci` can undo it again.
