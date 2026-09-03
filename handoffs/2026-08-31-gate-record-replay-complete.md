# Handoff — Phase 8: the parity suite now outlives the TypeScript reference

Written 2026-08-31, updated after the merge and release.

**Shipped since this was first written:** PR #246 merged to `main` as a merge
commit (not squashed — 176 commits of phase-by-phase reasoning were worth
keeping), `v0.2.0` published to npm and GitHub. The rollback window Phase 8
waits on is running from 2026-08-31.

Five further commits sit unpushed on `gates/less-host-dependent`; the standing
rule in this repo is that nothing touches origin without the owner saying so.

Supersedes `handoffs/2026-08-30-gate-record-replay.md`, whose "next steps" list
is now finished.

---

## What changed since that handoff

Every one of its eight steps is done. All **71** gates record and replay, and
`--replay` is wired into `ci.yml` beside the live run.

### Conversions finished

- The five remaining Class-B (vendor-stub) gates, the three Class-C (MCP,
  hand-built runtimes) gates, the two Class-D (in-process import) gates and the
  one Class-E (process invocation) gate — all listed as remaining work in the
  previous handoff.
- **Seven gates that were not in that taxonomy at all.** `check-mcp-parity`,
  `check-mcp-service-parity`, and the five fixture-driven MCP gates
  (`mcp-agent-env`, `mcp-database`, `mcp-git`, `mcp-onboard`, `mcp-profiles`)
  drove the reference as an *MCP process* built by hand. They were **passing in
  replay by running the TypeScript reference anyway** — the mode did not reach
  them. They now take their reference from `referenceSpec()`, which in replay is
  a path that cannot exist, and wrap the per-step answer in `recorder.recorded`.

### Eleven replay failures, each a real gap

The first full replay sweep was 60/71. None of the eleven were port defects;
each was something a recording could not carry, and each is fixed at the seam
rather than papered over:

| Gate | Why it could not replay | Fix |
| --- | --- | --- |
| `agent-info` | Four phases, four harnesses, **one** recording file — each phase overwrote the last, and replay answered a phase with another phase's replies. | `RuntimeHarness` takes an optional gate name; the gate records one file per phase. |
| `agent-info` (again) | Claude Code flattens a project directory into one path segment, so the workspace appears in a spelling the path substitution never finds. | `tokenise` learned the slugged spelling of home and workspace. |
| `agent-registry` | The seed archive was written to the *harness root*, which belongs to neither runtime and so is not rewritten — replay read a path from the run that recorded it. | Export into the reference's own home. |
| `git-reads`, `snapshots` | A commit sha is in the **request path**, and the fixture stamped commits from the wall clock, so every run asked for a commit the recording had never heard of. | Pin `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` in the seeds. |
| `github-connection` | The reference's config mutations never happened: `recorded()` skips the request entirely, so the native shadow behind the replay server was never driven — and the gate reads that config at the end. | In replay the request is still sent (the shadow makes the writes); only the answer and the vendor calls come from the recording. |
| `metrics`, `service-config` | The answers name the process holding a port — the gate itself. | `tokenise` learned `process.pid`, and the process *group*, which differs from the pid unless the gate was detached by the runner. **Matched by the place a pid is reported, not by its value**: the first cut replaced every occurrence of the number and rewrote `line 4941` in a five-thousand-line log fixture the day the pid was 4941. |
| `agent-auth` | The registry stub's ephemeral port is the gate's, not a runtime's. | `volatile()` — see below. |
| `onboard` | The source tree both runtimes clone from lives outside either home. | `volatile()`. |
| `service-inspector` | Half its steps speak to the **inspector proxy** the daemon opened, on a port it chose. Nothing can stand in for that. | The whole closure is the recorded unit; ports are learned from replayed answers too. |
| `terminal` | `ENOTEMPTY` cleaning up a root a process was still writing into. | `maxRetries: 5` on the cleanup `rm`, in all 56 gates that share the line. |

### `volatile()` — the general seam

`test/support/parity-recording.ts` exports `volatile(value)`. A gate registers
anything *it* minted that a recording must not keep — a stub's ephemeral port, a
directory outside either runtime's tree — and the value is tokenised by
position. Homes, workspaces, ports, the node binary, the gate's pid and its
process group are already handled without registration.

### Two gate defects that were not about replay at all

Both were found because replay runs the candidate *alone*, which is faster than
running it beside the reference — and speed was the hidden variable:

- **`nomoreide_agents_snapshot_agent` reported no backup.** A backup is named
  for the second it was taken in, and both runtimes give up after ten spellings
  of one second. Fifty-odd steps of the agent-env plan back a file up; running
  alone, eleven landed in the same second and the eleventh wrote without a copy.
  The gate now prunes backups between steps, so the second never fills. **This
  was latent in live mode** — a faster machine would have tripped it.
- **The tree comparison compared a backup chosen at random.** `readTree`
  collapses every backup of one file onto a single key, so which one's bytes
  landed there depended on how many the run made and in what order they were
  read. Two runs of the *same* runtime disagreed. Backups are no longer part of
  the tree comparison; what was backed up is asserted in the answer of the step
  that made it, where it is stable. Skill *directories* set aside under
  `agent-env-backups/` are still compared, with the stamp normalised.

---

## How to run it

```bash
# live, the default and still the strongest check
npm run parity -- "$PWD/target/debug/nomoreide"

# refresh recordings — through the runner, always: it detaches each gate, so
# the process group a recording captures is the one a replay will have
npm run parity -- "$PWD/target/debug/nomoreide" --record
npm run parity -- "$PWD/target/debug/nomoreide" --only check-git-reads-parity.ts --record

# prove the suite survives deleting src/
npm run parity -- "$PWD/target/debug/nomoreide" --replay
```

`CLAUDE.md` documents this next to the paragraph on gate discovery.

---

## Where the refactor stands now

| Surface | Reference | Rust | Missing |
| --- | --- | --- | --- |
| `/api/*` routes | 128 literal paths | 241 registered | **0** |
| MCP tools | 90 | 90 | **0** |
| CLI entry points | 17 | 17 | **0** |

The port is complete and the suite no longer depends on the thing Phase 8 wants
to delete. What is left:

1. **Ship a native release, wait out the rollback window, then delete `src/`.**
   Wall-clock, not work — and the release needs the owner's go-ahead.
2. **`crates/nomoreide-tauri` still owns its own `ProcessManager`** (six
   references, no `DaemonClient`; the crate does not even depend on
   `nomoreide-daemon-client`). Phase 6 asked for runtime state to be canonical
   in the daemon; for the desktop app it is not.

   **This is sequenced after (1), not before it** — two concrete reasons, both
   found while scoping it:

   - `commands/services.rs::service_processes` needs the service's **pgid** to
     assemble a process tree, and the daemon's wire status deliberately has no
     such field *because the TypeScript reference has none*. Adding it makes the
     daemon answer something the reference does not, which is a parity
     divergence in every gate that reads `/api/status`. The field can only be
     added once the reference is gone.
   - `lifecycle::ensure()` starts a daemon by running `<current_exe> daemon`.
     The desktop binary's `main.rs` handles only `--terminal-attach` and
     otherwise opens the GUI, so calling `ensure()` from the app would launch a
     second copy of the app. The desktop needs either its own `daemon`
     subcommand or a way to find the installed CLI — a design decision, not a
     mechanical edit.

   Beyond those: converging touches `commands/services.rs` (252 lines),
   `dashboard.rs`, `logs.rs`, `git.rs`, and the window-close lifecycle in
   `lib.rs`, which currently kills every service the app started — under the
   daemon they would survive the app closing, which is a deliberate behaviour
   change worth naming out loud. Keep the `#[tauri::command]` signatures and
   payload shapes identical and map `ServiceRuntimeStatus` to `ServiceStatus`
   inside Rust; `apps/dashboard/src/lib/api/tauri-bridge.ts` reads the current
   shapes and should not have to change. **No gate covers the desktop app.**

---

## What the first CI run of this branch found

The branch had never run in CI (one PR at the very end, by design), so its
first run surfaced two things no local check could:

- **Clippy 1.98 versus 1.89.** CI installs `dtolnay/rust-toolchain@stable`;
  this machine was nine releases behind, and six real lints were invisible
  locally. `rustup update stable` before trusting a green clippy. Fifteen more
  were `result_large_err` on `axum::response::Response` — the framework's own
  error type, 128 bytes, exactly the threshold — and `nomoreide-daemon` allows
  that lint with the reason written down.
- **A recording is a committed file, and it was a picture of this machine.**
  `metrics.json` held the whole process table: every command line, every user
  name, personal paths, a second checkout's path. The gate compares that
  answer's *shape*, and a shape collapses an array to `<array>`, so none of it
  was ever read. Three fixes: the checkout and the user's home are tokenised
  like a runtime's home already was (which also made replay portable to a CI
  runner, where the checkout path is different), and `harness.redact(...)` lets
  a gate trim a body on its way into the recording. `metrics.json` went from
  1.1 MB to 12 KB, and no recording names a person any more.

  The branch history was rewritten so the unredacted file never existed on it,
  and force-pushed. **The orphaned blob is still fetchable from GitHub by its
  SHA** (`5490a26c6655a4d2686c5072618b8318f3e15ea9`) until GitHub garbage-
  collects; ask GitHub Support to purge it if that matters.

## Thirteen host dependencies, and what became of them

The section below describes the problem as first found. It has since been
worked through: **seven gates stopped reading the host, and six declare what
they read.**

Stopped reading the host:

| Fix | Gates |
| --- | --- |
| `SHELL` pinned in both harnesses | `terminal`, `terminal-streams` |
| PATH *replaced* rather than prefixed | `agent-env`, `mcp-agent-env`, `mcp-profiles` |
| The fixture plants the agents it claims | `agent-profiles` |
| Daemon runs from the fixture workspace, not the checkout | `fs-directories` |

The PATH one was not merely hygiene. Three gates plant a `claude` stub, delete
it, and ask what "not installed" looks like — and with the machine's PATH still
trailing, a developer with the real CLI installed had that question answered by
their own binary, on both sides. `check-agent-env-parity` has a case named
`agents/after-the-claude-stub-leaves-the-path` that reported
`available: true` with a real path. **It had never once tested the thing in its
own name.** It now reports `available: false`.

Declaring what they read — `git-actions`, `git-branch`, `git-remote`,
`mcp-git`, `mcp-onboard`, `cli`:

These compare git's *own words*, and that comparison is worth keeping
unnormalised: it is what says the port surfaces git's message rather than
inventing one that reads about right. So the recording is stamped with the git
that made it —

```json
{ "version": 1, "gate": "git-branch", "bindings": { "git": "git version 2.44.0" }, ... }
```

— and a replay against a different git stops with a named reason instead of a
diff, exiting `3` so the runner reports it skipped:

```
skipped: this recording is bound to git "git version 2.44.0" and this machine
has "git version 2.39.3". The gate compares that tool's own output, which
differs between versions — a mismatch here is the tool, not the port.
```

Live mode ignores bindings entirely, because there both runtimes call the same
git. `Recorder.bind(name, value)` is general; git is simply the first thing
anything needed to be bound to.

Verified after all of it: **71 passed / 0 failed live, 71 passed / 0 failed
replayed**, and each fix separately re-verified by reproducing the foreign
environment locally (agent CLIs hidden from PATH, a different `$SHELL`, a fake
`git --version` ahead on PATH).

## The limit of a recording, found by running it in CI

**A recording is only valid on the machine that made it.** This is the thing to
know before trusting replay anywhere new. Thirteen of the 71 gates diverge when
recordings made here are replayed on a GitHub macOS runner, and every one is
the same shape — the recording froze an answer that is true of the *recorder*,
not of either runtime:

| Gates | Recorded here | On a runner |
| --- | --- | --- |
| `terminal`, `terminal-streams` | `shell: /bin/zsh` | `/bin/bash` |
| `mcp-git`, `git-branch`, `git-remote`, `git-actions`, `mcp-onboard` | one git version's own output | another's |
| `agent-env`, `agent-profiles`, `mcp-agent-env`, `mcp-profiles` | the agent CLIs installed here | not installed |
| `fs-directories`, `cli` | this directory layout | `/Users/runner/work/...` |

Tokenising paths does not help: these are different facts, not one fact spelled
two ways. The home and checkout tokens are still right — without them the
recording carried a person's home into the repository — but they buy
portability of *paths*, not of the machine.

So the suite is a **pre-merge local gate**, run in both modes by whoever is
merging, and `ci.yml` says so where the step used to be. Live cannot run on a
runner either: the reference's node-pty answers `posix_spawnp failed.` for
every shell there, while the native binary spawns them.

**If CI coverage is wanted**, the way is to record *on the CI image* — a
`workflow_dispatch` job running `--record` that commits `test/expectations/` —
and accept that those recordings then stop replaying on a developer's machine.
One set cannot serve both. A smaller, cheaper step in the same direction is to
shrink the machine surface the gates touch: pinning `SHELL` in the harness
environment would fix the two terminal gates outright, and stubbing the agent
CLIs (which some fixtures already do) would fix four more.

## Repo facts worth not rediscovering

- **A record sweep is not a replay sweep.** Replay runs one runtime and takes
  ~10 minutes for all 71 gates; record and live run two and take far longer.
  `check-cli-parity` alone is several minutes in record mode.
- **Record recordings through the runner.** `run-parity-gates.ts` detaches each
  gate, so its process group equals its pid; a gate recorded straight from a
  shell captures a group that is not its pid, and the two spellings cannot both
  be replayed. `--record` on the runner is the documented way for this reason.
- **Contention looks exactly like a hang.** A record sweep run while another
  checkout's session was busy had gates that take one second time out at 600s,
  each leaving two daemons behind, each leak making the next gate slower. The
  same gates ran in 0.6s standalone minutes later. Before believing a timeout,
  check `ps aux | grep "src/index.ts daemon"`.
- **Verification recipe:** `cargo fmt --all --check`,
  `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo test --workspace`, `npm run lint` (src and dashboard only — `scripts/`
  and `test/` are linted by neither Biome nor `tsc`, so a gate's types are only
  as good as its next run), `npx tsc -p apps/dashboard/tsconfig.json --noEmit`,
  `npm run build`, `bash scripts/check-no-node.sh "$PWD/target/debug/nomoreide"`.
- **MSRV is 1.77.2.** `is_none_or` is a hard error; use `map_or`.
- **`serde_json` has `preserve_order` on** and must keep it.
- This tree has **parallel writers** — never `git stash` here, and never
  `git checkout -- <dir>`; scope any restore to a single named file.
