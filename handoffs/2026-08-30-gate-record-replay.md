# Handoff — Phase 8: making the parity gates outlive the TypeScript reference

Written 2026-08-30. Branch `rust-refactoring`. **Nothing is pushed.** Ten
commits sit ahead of `origin/rust-refactoring`; the standing rule in this repo
is that nothing touches origin without the owner saying so.

---

## Where the refactor actually stands

The **port is complete**. Measured, not asserted:

| Surface | Reference | Rust | Missing |
| --- | --- | --- | --- |
| `/api/*` routes | 128 literal paths | 241 registered | **0** |
| MCP tools | 90 | 90 (+`nomoreide_not_a_tool`, a test fixture) | **0** |
| CLI entry points | 17 | 17 | **0** |

The **removal is not**. Phase 8's exit gate is "no production command or
desktop path invokes Node.js, and the previous native release remains a
documented rollback target." What blocks it:

1. `src/` is still here — 203 files, ~45,200 lines.
2. **59 of 71 gates launch it.** Deleting `src/` deletes the suite. ← *this
   handoff's work*
3. Two Phase 8 bullets are wall-clock, not work: ship a stable native release,
   then remove TypeScript after the rollback window closes.
4. `crates/nomoreide-tauri` still owns its own `ProcessManager` (6 references,
   0 `DaemonClient`). Phase 6 asked for runtime state to be canonical in the
   daemon; for the desktop app it is not. **Not started.**

---

## What this session finished (committed)

- `c413e3e5e` — the whole CLI except the TUI: `add`, `list`, `logs`, `start`,
  `stop`, `restart`, `git`, `db`, `agents`, `profile`, `web`, and
  `daemon status|stop|restart`.
- `59d9a81b9` — `tui` and `__terminal-attach`.

Both are backed by `scripts/check-cli-parity.ts` — 127 cases, the first gate
that compares **processes** (stdout, stderr, exit code) rather than HTTP.

### Correction to carry forward

An earlier summary in this session said the CLI gate found "four defects, none
of them in the CLI". That was wrong for two of them, and the commit message for
`c413e3e5e` and the Phase 6 note in
`docs/plans/2026-08-20-native-rust-runtime-and-mcp.md` both repeat the
overstatement. **Amending them is an open task.** The honest split:

- **Pre-existing defects, genuinely found and fixed** (both reach shipped
  surfaces beyond the CLI):
  - `exitCode: null` was dropped from every service status. The wire type had
    `skip_serializing_if` on both `exit_code` and `signal`, so a signal-killed
    service reported no `exitCode` at all — "still running" and "killed by
    SIGTERM" became indistinguishable. Now `Option<Option<T>>` end to end,
    decided once in `runtime_status` via an `ended` flag. Reaches the daemon's
    HTTP routes, MCP, and the dashboard.
  - `agent_profiles::snapshot` saved an empty profile where the reference
    refuses. Reaches `nomoreide_profiles_snapshot` and the web route.
- **Bugs in the CLI code written this session**, caught before commit, never
  shipped: the `db check` wording, and `git log --limit banana`.

---

## The work in progress — record/replay for the gates

**Uncommitted.** Working tree:

```
?? test/support/parity-recording.ts     (new, the mechanism)
?? test/expectations/                   (new, recorded fixtures — 1 file so far)
 M test/support/runtime-parity.ts       (harness wired to it)
 M scripts/check-deploy-actions-parity.ts
 M scripts/check-deploy-routes-parity.ts
 M scripts/check-github-api-parity.ts
 M scripts/check-github-connection-parity.ts
 M scripts/check-github-template-parity.ts
 M scripts/check-host-routes-parity.ts
```

### The idea

`NOMOREIDE_PARITY_MODE` selects one of three modes; default is unchanged.

- **`live`** (default) — both runtimes run, gate diffs them. Still the strongest
  check, stays the default while `src/` exists.
- **`record`** — the reference runs behind a proxy on a private port; everything
  it answers is written to `test/expectations/<gate>.json`.
- **`replay`** — the reference is **not started**. The recording answers in its
  place and the gate cannot tell.

A recording is the same gate with the reference's answers frozen at the commit
that recorded them. What it loses is the ability to notice the reference
changing — which, after `src/` is deleted, cannot happen.

The gate name is derived from `process.argv[1]`, so a gate needs **no
registration** to participate.

### Two design points worth keeping

- **Tokenisation.** A recording is made in one tmpdir and replayed in another,
  so workspace/home/port/`process.execPath` are rewritten to `%%WORKSPACE%%`
  etc. on the way in and substituted back on the way out. That hands each
  gate's own normalisation exactly the text it already expects.
- **The no-spawn claim is self-enforcing.** In replay mode `referenceSpec()`
  returns `/nonexistent/the-typescript-reference-must-not-run-in-replay`. Any
  path that still tries to spawn the reference dies with ENOENT naming itself,
  rather than quietly working because `src/` happens to still be present.

### Gate classes, and what each needs

| Class | Count | Status |
| --- | --- | --- |
| **A** — plain HTTP against the daemon | 59 | **Done, zero gate changes.** The replay server answers transparently. |
| **B** — vendor stubs (`.take()`) | 12 | 6 converted, **5 left** (below) |
| **C** — MCP, but build runtimes by hand | 3 | **Not started** (below) |
| **D** — import `src/` in-process | 2 | **Not started** (below) |
| **E** — process invocations (`check-cli-parity`) | 1 | **Not started** (below) |

### The seam

One generic method covers everything HTTP replay can't stand in for:

```ts
harness.recorded(runtime, key, produce)   // RuntimeHarness
recorder.recorded(runtime, key, produce)  // Recorder, for gates without a harness
```

- `live` → calls `produce()`.
- `record` → calls `produce()`, and stores the value **only for the reference**.
- `replay` → for the reference, returns the recorded value without calling
  `produce()` at all; the candidate always runs for real.

`key` is a tripwire, not a lookup — entries are consumed in order. A gate whose
plan was reordered since recording stops and says to re-record, rather than
replaying the wrong answers.

`harness.takeStub(runtime, key, stub)` is a thin wrapper for draining a vendor
stub.

### Verified working

```
NOMOREIDE_PARITY_MODE=record node --import tsx scripts/check-extensions-parity.ts "$PWD/target/debug/nomoreide"
NOMOREIDE_PARITY_MODE=replay node --import tsx scripts/check-extensions-parity.ts "$PWD/target/debug/nomoreide"
node --import tsx scripts/check-extensions-parity.ts "$PWD/target/debug/nomoreide"
```

All three pass, 9/9. Replay passes with the reference pointed at a
non-existent binary, which is the proof it is never spawned.

The six converted Class-B gates were re-run in **live** mode and still pass:
`host-routes` 54, `github-api` 78, `deploy-actions` 50. The other three
(`deploy-routes`, `github-connection`, `github-template`) were converted the
same way but **have not been re-run** — do that first.

---

## Next steps, in order

### 1. Re-run the three unverified conversions (live mode)

```bash
for g in deploy-routes github-connection github-template; do
  node --import tsx scripts/check-$g-parity.ts "$PWD/target/debug/nomoreide" | tail -2
done
```

### 2. Convert the remaining 5 Class-B gates

`check-provider-oauth-parity.ts`, `check-provider-env-parity.ts`,
`check-mcp-deploy-parity.ts`, `check-mcp-github-parity.ts`,
`check-mcp-registry-parity.ts`.

The pattern used in the six already done: wrap the **whole per-runtime
observation** — answer + stub requests + any persisted-config read — in one
`harness.recorded(runtime, step.name, async () => ({...}))`. Wrapping the unit
rather than each `.take()` is deliberate: that unit *is* the comparison, and in
replay the reference produced all of it at record time or none of it now.

Watch for: several gates call `stub.take()` twice per step — once to *discard*
before the step, once to *collect* after. Only the collecting call belongs
inside `recorded`.

### 3. Class C — the three MCP gates that build runtimes by hand

`check-mcp-deploy-parity.ts`, `check-mcp-github-parity.ts`,
`check-mcp-registry-parity.ts` do **not** use `RuntimeHarness` — they construct
runtimes themselves and call `callMcpTool` directly, so they get no HTTP
replay. Give each a module-level `const recorder = new Recorder()` (exported
from `test/support/parity-recording.ts`), wrap the reference side of their
`call()` helper in `recorder.recorded(runtime, step.name, …)`, and call
`await recorder.finish()` in the `finally`.

These overlap with Class B — their `call()` helper already returns
`{reported, requests}`, which is the right unit to wrap.

### 4. Class D — the two gates that import `src/` in-process

`check-git-actions-parity.ts` and `check-host-parity.ts` import TypeScript
modules directly (`from "../src/core/..."`). **The HTTP replay cannot help
them**, and their imports fail at module load once `src/` is gone — so they
need their reference-side computation wrapped in `recorder.recorded(...)`
*and* the top-level import made lazy (dynamic `import()` inside the
non-replay branch), or they will not even parse.

`check-host-parity.ts` is the clearer of the two: `runReference(side, step)`
returns one value and is the whole seam.

### 5. Class E — `check-cli-parity.ts`

It spawns the binary itself. Wrap the reference-side `invoke(...)` in
`harness.recorded(reference, step.name, () => invoke(...))`. The transcript
(`{code, signal, stdout, stderr}`) is already a plain object, so it tokenises
cleanly. Note the TUI steps write to stdin on a timer — that side does nothing
in replay, which is correct.

### 6. Record every gate

Sequential, **not** parallel — each gate starts two daemons and several at once
produce timeouts that are contention, not divergence (this has bitten before).
Budget ~60–90 min.

```bash
for g in scripts/check-*-parity.ts; do
  NOMOREIDE_PARITY_MODE=record node --import tsx "$g" "$PWD/target/debug/nomoreide" || echo "FAILED $g"
done
```

Then prove the whole suite replays:

```bash
for g in scripts/check-*-parity.ts; do
  NOMOREIDE_PARITY_MODE=replay node --import tsx "$g" "$PWD/target/debug/nomoreide" || echo "FAILED $g"
done
```

Do **not** run a cargo build during either sweep — CPU contention makes gates
time out and look like divergences.

### 7. Wire it into the runner and CI

`scripts/run-parity-gates.ts` discovers gates by globbing `scripts/check-*-parity.ts`
— there is no list to update. Add a `--replay` passthrough that sets the env
var. CI should keep running **live** while `src/` exists; replay is what proves
the suite survives its deletion.

### 8. Then, and only then

Tauri convergence (item 4 in "Where the refactor stands"), and the amendments
noted under "Correction to carry forward".

---

## Repo facts worth not rediscovering

- **Verification recipe:** `cargo fmt --all --check`,
  `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo test --workspace`, `npm run lint` (0 errors; 74 warnings are
  pre-existing), `npx tsc -p apps/dashboard/tsconfig.json --noEmit`,
  `npm run build`, `bash scripts/check-no-node.sh "$PWD/target/debug/nomoreide"`.
  All green as of `59d9a81b9`.
- **CI builds Tauri.** `cargo {clippy,test,build} --workspace` includes it — do
  not verify with `--exclude nomoreide-tauri` and call it done. It builds in
  ~34s warm.
- **Gates want absolute candidate paths.** Several spawn from a temporary
  workspace, so `./target/debug/nomoreide` resolves to nothing. Use `"$PWD/..."`.
- **MSRV is 1.77.2.** `is_none_or` is a hard error; use `map_or`.
- **`serde_json` has `preserve_order` on** and must keep it.
- `target/` was 4.9 GB at handoff. A full `cargo clean` plus
  `cargo build -p nomoreide-cli` rebuilds in ~30s, so cleaning is cheap.
- This tree has **parallel writers** — never `git stash` here, and never
  `git checkout -- <dir>`; scope any restore to a single named file.
