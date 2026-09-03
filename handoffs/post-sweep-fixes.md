# Queued until the onboard sweep prints its summary

Editing a gate while its sweep runs poisons every later verdict, so these wait.

## check-onboard-parity.ts
- Add `register/a-name-that-is-only-spaces`:
  `{"name":"   ","cwd":"<repos>/demo-app","command":"node -v"}`.
  The reference does **not** trim the name, so it registers a service called
  `"   "`. Without this case the seed `a-name-is-trimmed` cannot bite — `""`
  trimmed is still `""`.
- Then re-run: `python3 handoffs/sweeps/onboard-sweep.py a-name-is-trimmed`

## Verdicts to re-run after the fixes
- `a-name-is-trimmed` (GATE-DID-NOT-BITE, needs the case above)
- `the-guard-is-a-prefix-test` (re-aimed in the sweep file to
  `register/a-cwd-named-dot-dot-something`; the running process still had the
  old expectation)

# Slice survey (accurate as of the snapshots + triggers work)

Counted by extracting `.route("…")` from the Rust server and `route(…)` /
`patternRoute(…)` from `src/web/routes/`. 55 exact routes and ~40 pattern routes
remain. Grouped by what they actually need:

## Route plumbing only — the Rust core is already there
- **terminal** — `insert-prompt` and `/api/terminal/sessions/:id` (PATCH rename,
  DELETE) are missing while their four siblings are served, and the HTTP
  terminal surface has **never been gated** (`check-mcp-terminal-parity.ts` is
  the MCP one). Smallest remaining win.
- **errors** — `/:id/bundle` and `/:id/fix` (`/:id/prompt` is served).
- **overview** — one pattern route over `project-overview.ts` (188 lines, not
  ported).

## Needs a core port first
- **context** — `context_library.rs` has the notes CRUD but not `list()` or
  `graph()`, which is most of `context-library.ts`'s 670 lines.
- **agent-settings** — 3 endpoints over a 161-line core. The risk is that a
  parse failure is reported with **V8's own `JSON.parse` message** and
  `smol-toml`'s, both quoted verbatim into the response.
- **metrics / dashboard** — need `statusWithResources` / `processTree`, absent.
- **ssh-server** (6), **docker** (5), **agent-env / profiles / registry** (~15),
  **jetbrains-import** (2), **skills** (2, a remote service).

## Out of scope for Phase 6 (Server-Sent Events)
`/api/errors/stream`, `/api/terminal/events`, `/api/onboard/install/stream`,
`/api/agent/tool-calls/stream`, `/api/services/:name/test/stream`,
`/api/workflow-triggers/pending/stream`.

## check-onboard-parity.ts — the conflict case never conflicts
`register/a-start-that-conflicts` names port 4599, but nothing was ever
listening on it: `register/a-local-service` registered that port without
starting, and `register/start-is-true` starts `sleep 30`, which binds nothing.
So the case succeeds and the seed `a-port-conflict-is-a-409` cannot bite.

Fix the way `check-service-config-parity.ts` does it — the gate holds the port
itself, so both runtimes meet the same holder and the pid in the message is
identical on both sides:

```ts
import { createServer, type Server } from "node:net";
const HELD_PORT = 4599;
let held: Server | undefined;
// before the step loop:
held = createServer();
await new Promise<void>((resolve, reject) => {
  held!.once("error", reject).listen(HELD_PORT, "127.0.0.1", resolve);
});
// in the finally: held?.close();
```

Then re-run: `python3 handoffs/sweeps/onboard-sweep.py a-port-conflict-is-a-409`


# Terminal slice — sized, ready to write

Pure route plumbing: the Rust core already has every operation.

| endpoint | core call |
| --- | --- |
| `POST /api/terminal/sessions/:id/insert-prompt` | `TerminalManager::insert_agent_prompt` |
| `PATCH /api/terminal/sessions/:id` (rename) | `TerminalManager::rename_session` |
| `DELETE /api/terminal/sessions/:id` (close) | `TerminalManager::close_session` |

Details the reference has that a port must carry:

- **`insert-prompt` is guarded by a header**, `x-nomoreide-terminal-control: 1`,
  and a request without it is a **403** before the id is even decoded. The two
  siblings already served share that guard.
- **Two id schemas, not one.** The action routes decode with a schema that also
  refuses `/` and `\\`; `/api/terminal/sessions/:id` uses a laxer one that only
  refuses control characters and allows 1000 characters rather than 200.
- **Three sizes for one prompt.** The body is read with a cap
  (`MAX_AGENT_PROMPT_BYTES * 6 + 1024`) that answers **413**; the parsed prompt
  is measured again in UTF-8 bytes against `MAX_AGENT_PROMPT_BYTES`, also 413;
  and `encodeAgentPromptPaste` refuses a prompt carrying a submit character with
  its own message as a **400**.
- **404 versus 409 is decided by the message.** Both routes branch on whether it
  starts with `Unknown terminal session:`.
- A close answers `{ ok: <whether it closed>, sessions: [...] }` — `ok: false`
  with status **200** for an id that was not there, unlike everything else here.

## Snapshots sweep — three verdicts to act on

Run of 2026-08-26, parallel runner, 28 seeds.

- **`a-rename-reports-the-old-sha` — GATE-DID-NOT-BITE.** The seed makes `rename`
  answer with the sha it was given instead of the one `update-ref` just wrote.
  `rename/the-old-sha-is-gone` cannot see that: it asks about the old sha
  directly and gets the same 404 either way, and the sha in the rename's *own*
  answer is scrubbed as volatile. **Fix:** after a rename, ask for the changed
  files at the sha the rename reported. Under the seed that sha no longer
  exists, so a 200 becomes a 404 — runtime-independent, since each side follows
  its own answer.
- **`a-rename-does-not-trim-its-label` — GATE-DID-NOT-BITE.** The seed keeps the
  trim in the emptiness test but drops it from the stored label. Every rename
  case passes a label with no surrounding whitespace, so nothing changes.
  **Fix:** rename with `"  padded  "` and compare the label that comes back.
- **`a-restore-writes-the-index-too` — GATE-DID-NOT-BITE.** The seed adds
  `--staged` to the restore, so the same files land staged rather than merely
  changed. Nothing in the restore's *own* answer moves — `preRestore`,
  `restoredFiles` and `deletedPaths` are all identical — because the index is
  not part of it. **Fix:** follow the restore with a read of the repository
  status (`/api/git/status`), which is the only endpoint that distinguishes
  staged from unstaged. Reaching into a neighbouring domain is right here: the
  claim being gated is what the restore *left behind*, and no snapshot endpoint
  can see it.
- **`any-commit-is-a-snapshot` — CAUGHT-WRONG-CASE.** Expected
  `guard/a-commit-that-is-not-a-snapshot`; the seed turns the namespace guard
  into a fabricated `Snapshot`, which changes several answers at once. Re-aim at
  whichever case the run reports, or narrow the seed.

## Terminal slice — state

Gate is `scripts/check-terminal-parity.ts`, **59 cases**, not yet run. This
session corrected two things in it that would have made it pass vacuously:

- the transcripts cases had no transcripts — the fixture now plants nine
  sessions across both providers, with explicit mtimes (the listing orders by
  mtime alone, and two files written in the same millisecond order arbitrarily);
- `insert/a-body-that-is-too-large` sent 200KB, under *both* caps, so it was
  testing an ordinary prompt. There are now three size cases: over the body cap,
  over the prompt cap, and under the cap in characters but over it in bytes.

The fixture also pins a divergence found by reading: `/api/terminal/transcripts`
resolves the repository path itself rather than through `selectedGitCwd`, so it
uses `activeWorktreePath` **without checking it is a worktree**. The config
names a stale one, which makes the scoped listing and the unscoped listing
disjoint.

The Rust patch is drafted in the session scratchpad as `terminal-patch.py` and
lands once the sweeps are off the tree.

## Phase 6 — what is left after the terminal slice

Measured, not estimated: reference routes extracted from `src/web/routes/*.ts`,
Rust routes from `crates/nomoreide-daemon/src/server/**/*.rs`, `:param`
normalised against `([^/]+)`/`(\d+)` and alternation groups expanded.

- **122** exact `/api` paths in the reference, **55** with no Rust route.
- **84** pattern endpoints once alternations are expanded, **49** served, **35**
  not.

The terminal slice closes three of those (`sessions/:id`,
`sessions/:id/insert-prompt`, `transcripts`). The rest group into slices:

| slice | endpoints | note |
| --- | --- | --- |
| overview / dashboard / metrics / hosts / providers / extensions | ~7 | read-only aggregations, no writes |
| context library | 6 | `/api/context`, `graph`, `notes`, `notes/:id`, `pins`, `preview` |
| agent change-sets | 4 | list, get, diff, restore |
| docker | 9 | containers list/inspect/logs/files/file + start/stop/restart |
| servers | 9 | registration, probe, metrics, files, terminal |
| agent-env | 26 | the largest by far — profiles, settings, auth, registry |
| agent chat / usage / tool-calls | 12 | includes a stream |
| misc | ~8 | errors bundle+fix, services inspector/metrics/test, skills, jetbrains import, processes/terminate |
| SSE streams | 6 | `terminal/events`, `errors/stream`, `agent/tool-calls/stream`, `workflow-triggers/pending/stream`, `services/:name/test/stream`, `onboard/install/stream` |

The streams are their own problem: `RuntimeHarness` drives `fetch`, and none of
the existing gates can read an event stream. That is a gate capability to build
once, before any of the six are ported — not six ad-hoc comparisons.

## Context library — the slice after terminal

Gate written and registered: `scripts/check-context-parity.ts`, **69 cases**,
`npm run context-parity`. Seven endpoints, one domain, no zod message
reproduction anywhere — every refusal is a flat sentence, which makes this much
cheaper than the onboard slice was.

What the gate has to work around: **nothing in this surface is stable between
two runtimes.** A note's id is a fresh uuid, its revision is a sha256 over a file
containing that uuid and two timestamps, and its filename is built from both. So
ids and revisions are resolved per runtime from its own listing — `{{ID:title}}`
and `{{REV:title}}` in a case are substituted at send time, the same trick the
snapshots gate uses for shas.

What the Rust core already has (`crates/nomoreide-core/src/context_library.rs`,
692 lines): `notes`, `get_note`, `create_note`, `update_note`, `delete_note`,
`pinned`, `set_pinned`, `preview`.

What it does **not** have, and is therefore the actual work:

- **`list()`** — the snapshot the `GET /api/context` envelope is spread from.
  Notes are only part of it; the rest are *derived* items built from config
  (services, repositories) and the error inbox, ~91 lines in the reference.
- **`graph()`** — nodes and edges from wiki links, with a pinned-first ordering
  and a node cap, ~54 lines.

The two filters they share (`q`, `projectPath`, `kinds`) are worth care:
`kinds` is split on commas and silently drops what it does not recognise, so
`kinds=widget` is an **empty** filter rather than an absent one, and an empty
filter matches nothing at all. The gate has cases for the unknown kind alone,
mixed with a known one, blank, and repeated.

## One correction to the remaining-work table

`/api/hosts/*` is **not** Phase 6 work. `scripts/check-host-parity.ts` says so in
its own header — the Vultr provider is gated through an `examples/vultr-probe.rs`
binary precisely because neither MCP nor the native daemon serves it, and the
route is deferred. It came up in the endpoint diff only because the diff compares
route tables, which cannot see a phase boundary. Nine endpoints come off the
list.

## Change-sets — a third gate written ahead of its port

`scripts/check-change-sets-parity.ts`, **34 cases**, `npm run
change-sets-parity`. Four endpoints over a plain JSON file at
`~/.nomoreide/agent-sessions.json` that these routes only ever read, so the gate
plants the store directly — which is also the only way to give a session a
snapshot sha that exists, since the sha has to come from a snapshot each runtime
took for itself.

Two things a port will get wrong if it is not told:

- **The id is never decoded.** Every other `:id` in this codebase runs through
  `decodeURIComponent`; these three compare the raw path segment against the
  stored id. A session stored as `a%2Fb` is reachable only by sending `a%252Fb`,
  and a session whose id contains a real `/` is not reachable at all. The
  fixture stores both so the difference is visible either way.
- **A missing snapshot and an unknown session are the same 404.** Restore and
  diff both read `session?.snapshotSha` and cannot tell them apart. `GET /:id` is
  the only one that can, and it answers a session with no snapshot as a
  *success* carrying an empty file list.

The Rust core has no agent-session store at all — `crates/nomoreide-core` has
`agent_context`, `agent_env`, `agent_profiles`, `agent_runtime` and
`agent_transcripts`, none of which is this. It is about sixty lines: read the
file, tolerate anything that is not an array of sessions, and find by id.
`SnapshotManager` already provides everything the three sub-routes need.

## Second sweep round — verdicts and what they mean

### Snapshots: two seeds retired, two probes re-aimed

The four misses split cleanly in two, and the distinction is worth keeping.

**Unobservable seeds, now retired** — the code trims in *two* places, so removing
one trim changes nothing that reaches disk:

- `a-rename-does-not-trim-its-label`: the route trims, then
  `SnapshotManager::rename` trims again before writing the commit message. The
  inner trim decides. (The route's trim still earns its keep — it is what makes
  the route's own emptiness check right — and *that* is caught, by
  `a-blank-rename-label-is-defaulted`.)
- `a-delete-does-not-trim-its-id` (workflow-triggers):
  `ConfigStore::remove_workflow_trigger` trims the id itself.

A seed that cannot be observed is not a gate hole, and adding cases to chase one
makes the gate worse, not better.

**Real gate holes, now fixed** — both were aimed at endpoints that cannot see
the change:

- `a-rename-reports-the-old-sha`: `/files` and `/diff` **do not consult the
  namespace guard** — they diff whatever commit they are handed — so a stale sha
  answers 200 there. Only `rename`, `restore` and `delete` call `find`, and
  rename is the only one of those that does not move the working tree. The probe
  is now a second rename of the reported sha.
- `a-restore-writes-the-index-too`: the probe reached for `/api/git/status`
  correctly but used "first checkpoint", which was taken on a *clean* tree — so
  restoring it returns the worktree to exactly HEAD and the status is empty
  however the index was written. The gate now takes a snapshot while the tree is
  dirty, puts the worktree back, and restores that.

### Terminal: two cases to add once the sweep is off the gate

Both are missing cases rather than wrong ones, and neither can be added while
the terminal sweep is running — editing a gate mid-sweep poisons every verdict
after it.

- `any-header-value-passes` (GATE-DID-NOT-BITE). The seed accepts the control
  header with *any* value, not just `1`. Every case either sends `1` or sends
  nothing, so nothing observes it. **Fix:** the `control` field has to carry a
  value rather than being `true`, and a case has to send `0`.
- `the-body-cap-is-gone` (GATE-DID-NOT-BITE). The body cap is deliberately six
  times the prompt cap, so **any** body it refuses is one that could not hold a
  valid prompt — and the case that reaches it sends a huge *prompt*, which the
  next check refuses with the same 413 and the same words. The two are
  indistinguishable that way round. **Fix:** send a body over the cap that is
  not a prompt at all (`{"colour":"<huge>"}`). With the cap it is a 413; without
  it the body parses and the schema refuses it as a 400.
- `a-prompt-may-be-any-type` (GATE-DID-NOT-BITE). The seed stringifies a
  non-string prompt. The case aimed at it sends `{}` — an *absent* prompt, which
  both versions refuse identically. **Fix:** send `{"prompt": 7}`. The reference
  refuses it as a 400; the seed pastes `"7"` and answers 200.
- `a-label-is-bounded-before-it-is-trimmed` (GATE-DID-NOT-BITE). The seed applies
  the 60-character bound to the *raw* label rather than the trimmed one. Every
  rename case sends a label that is short both ways. **Fix:** a label of exactly
  60 characters with padding around it — 60 trimmed, 64 raw. The reference
  accepts it; the seed refuses it.
- `the-id-is-checked-before-the-header` (CAUGHT-WRONG-CASE). Expected
  `insert/an-id-with-a-slash`, which sends a bad id *with* the header — and with
  the header present both orderings answer 400, so that case cannot tell them
  apart. **Fix:** a bad id and **no** header. The reference answers 403; the seed
  answers 400.

## Context library — port drafted, sweep drafted, gate hardened

All three pieces are ready; only the build and the run are outstanding.

**The port** (in the session scratchpad as `context-patch.py`, which copies two
files and edits three):

- `crates/nomoreide-core/src/context_snapshot.rs` (new, ~590 lines) — the
  listing and the graph. The builder takes config, incidents and transcripts as
  **arguments** rather than the library holding them, matching
  `ContextLibrary::preview`, which already works that way: the library owns the
  vault, and the vault is only ever part of what the page shows.
- `crates/nomoreide-daemon/src/server/routes/context.rs` (new, ~475 lines) —
  seven routes, four fixed refusal sentences, no zod reproduction anywhere.
- `ContextLibrary::notes_and_diagnostics`, because `notes()` drops the
  duplicate-id diagnostics the listing has to report.

**Two divergences found while drafting, both fixed in the patch:**

- The Rust vault root read `NOMOREIDE_CONTEXT_VAULT` with `var_os` and no trim,
  where the reference trims it and treats blank as absent. A vault path of `"  "`
  would have sent the two runtimes to different directories.
- My first draft filtered notes by their single `projectPath`. The reference
  also matches a note's whole `projectPaths` **list**, so a note filed under
  three repositories appears under all three. The gate case
  `filter/a-project-path` would have caught it — which is the argument for
  writing the gate first, again.

**The gate** is now 77 cases, up from 69, after a review that found the same
class of bug the terminal gate had — cases that pass without proving anything:

- `id` was redacted everywhere, which also redacted **derived** ref ids. A
  project's id is its path, a service's is `<project>:<name>`, a file's is a
  hash — all worth comparing. A uuid is now redacted for *being* a uuid rather
  than for sitting under a key called `id`.
- `CODEX_HOME` was not set, so the transcript reader fell through to the
  developer's own Codex installation and the listing depended on the machine.
- A service whose cwd is outside every registered repository was added, because
  without one the `workspace:` fallback in a service ref id is unreachable.
- `filter/a-whitespace-query` was added: an *empty* query matches everything by
  accident (`"".contains` is true of any string), so only a whitespace query can
  show whether it was trimmed before use.

**The sweep** is `handoffs/sweeps/context-sweep.py`, 41 seeds. Two were caught
being no-ops during a self-review before running — one only added a comment, and
one removed an emptiness guard whose absence changes nothing.

## Change-sets — ported, 34/34 first run

`crates/nomoreide-core/src/agent_sessions.rs` (the store, ~60 lines) and
`crates/nomoreide-daemon/src/server/routes/change_sets.rs` (four routes). The
gate written two commits earlier passed on the first run with no fixes, which is
the first slice in this phase to do so — and the argument for the gate-first
order, since every other slice found divergences the moment it was gated.

Three things the gate had already pinned, and the port therefore got right
without discovering them the hard way:

- The `SnapshotManager` is built from the **session's own `repoPath`**, not from
  the selected repository. An agent works where it works and the dashboard may
  have moved on; restoring into whatever is selected now would put one
  repository's files into another.
- The id is never decoded — these three routes compare the raw path segment.
- An unknown session and a session with no snapshot are the same 404 with the
  same wording, and the wording names the *snapshot*, so a caller asking about a
  session that never existed is told it has no snapshot.

## A rule I broke, worth restating

Ran `cargo build` and `cargo clippy` while the context sweep was running. Clippy
duly reported an error in seeded code — `project_paths` "never used", because
the seed then applied had removed its only caller — and the build raced the
sweep's own build over one `target/`.

Neither corrupted anything this time, but the failure mode is a sweep whose
remaining seeds all report `SEED-DID-NOT-COMPILE` against code the sweep did not
write. **Check `pgrep -f sweeps/.*sweep.py` before any cargo invocation**, and
treat a clippy error naming an unused item as a signal to check for a running
sweep before believing it.
