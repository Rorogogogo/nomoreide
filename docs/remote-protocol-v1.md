# Remote control protocol

**Status:** v1 frozen; v2 current. v1 is Phase 1 of
`docs/plans/2026-08-20-remote-control-relay-after-rust.md`, and v2 added the
terminal mirror described in
`docs/plans/2026-09-02-remote-terminal-stream-v2.md`. v2 **added frames and
removed none**, which is why `MINIMUM_SPEAKABLE_VERSION` is still 1: a v1 daemon
is not broken, only smaller, and it simply never advertises the terminal
capabilities.

Two independently deployed programs speak this wire format: the daemon on a
developer's machine, and the hosted platform's API in `../nomoreide-platform` —
different repositories, different Cargo workspaces, different release cadences.

**They share one implementation.** It is `crates/nomoreide-remote-protocol`, a
package with three dependencies (`serde`, `serde_json`, `chrono`), deliberately
light enough for an API container that has no use for `nomoreide-core`'s sqlx,
PTY and tar stack. The daemon reaches it as
`nomoreide_core::remote::protocol`; the platform depends on the published crate.
Writing it twice would make it two implementations of one meaning, which is the
mistake the desktop app already made and is still paying 150 duplicated commands
for.

This document is the contract in prose. The golden fixtures below are the
executable record of the frame *shapes*, which is the part a shared parser does
not protect: a field renamed or an optional that starts serialising as `null`
breaks a peer that has not been rebuilt, and fails no type-level test.

Changing anything here is a protocol change. That means a new major version and
a stated behaviour for the peers that still speak the old one — not a
one-character diff.

---

## The shape of a frame

```json
{
  "v": 1,
  "id": "req_1",
  "type": "service.action.request",
  "deviceId": "11111111-2222-3333-4444-555555555555",
  "sentAt": "2026-09-01T00:00:00.000Z",
  "replyTo": null,
  "payload": { "service": "api", "action": "restart" }
}
```

**The envelope is invariant.** These seven fields are fixed for the life of the
protocol; `v` versions the *payload union*, not the frame. That is what lets two
peers with no version in common still exchange a hello, a rejection and a
heartbeat rather than staring at each other.

| Field | Rule |
| --- | --- |
| `v` | Major protocol version. A frame naming another one is refused. |
| `id` | Request id, and the idempotency key. Non-empty, ≤128 bytes, printable ASCII without `"`. |
| `type` | The discriminant. Must be a name the *receiving direction* accepts. |
| `deviceId` | Same identifier rules as `id`. |
| `sentAt` | RFC 3339, UTC, milliseconds. Checked against the staleness window. |
| `replyTo` | The `id` this frame answers. Present exactly when the type requires it. |
| `payload` | The typed body. Every payload struct refuses fields it does not define. |

Unknown fields are refused at every level — envelope and payload both.

### Validation order

1. byte length → `FRAME_TOO_LARGE`
2. envelope shape and identifiers → `MALFORMED_FRAME`
3. protocol version → `UNSUPPORTED_PROTOCOL_VERSION`
4. `type` known in this direction → `UNKNOWN_COMMAND`
5. payload → `MALFORMED_FRAME`
6. `replyTo` rule for that type → `MALFORMED_FRAME`
7. `sentAt` window → `STALE_REQUEST`

Staleness is last on purpose. It is the one condition that goes away by itself,
and reporting it ahead of a wrong version or an unknown command would tell a
peer with a permanent bug that it had a transient one.

---

## Commands — platform → daemon

This union **is** the remote attack surface. A phone cannot ask the machine for
anything that is not listed here.

| `type` | Mutating | Capability |
| --- | --- | --- |
| `session.welcome` | no | *(control)* |
| `session.revoke` | no | *(control)* |
| `device.snapshot.request` | no | `device.snapshot` |
| `service.list.request` | no | `service.list` |
| `service.action.request` | **yes** | `service.action` |
| `service.logs.request` | no | `service.logs` |
| `bundle.list.request` | no | `bundle.list` |
| `agent.providers.request` | no | `agent.providers` |
| `agent.turn.start` | **yes** | `agent.turns` |
| `agent.turn.cancel` | **yes** | `agent.turns` |
| `agent.approval.resolve` | **yes** | `agent.approvals` |
| `terminal.sessions.request` | no | `terminal.sessions` |
| `terminal.spawn.request` | **yes** | `terminal.spawn` |
| `terminal.shell.request` | **yes** | `terminal.shell` |
| `terminal.attach.request` | **yes** | `terminal.attach` |
| `terminal.input` | **yes** | `terminal.attach` |
| `terminal.resize` | **yes** | `terminal.attach` |
| `terminal.detach` | **yes** | `terminal.attach` |
| `github.runs.request` | no | `github.actions` |
| `github.run.jobs.request` | no | `github.actions` |
| `github.prs.request` | no | `github.pulls` |
| `github.pr.request` | no | `github.pulls` |
| `agent.usage.request` | no | `agent.usage` |
| `errors.request` | no | `device.errors` |
| `timeline.request` | no | `device.timeline` |

No payload carries a command, argument, working directory, environment, port
override, SSH host, process id or kill strategy. `terminal.spawn.request`
carries a provider name and a prompt and **nothing else** — there is no field
for a path or an argv, which is how there comes to be no way to name one.

**Excluded, and refused by name:** filesystem browsing or writes, git mutations,
database queries or write-unlock, service and config registration, environment
and credential reads, provider and deployment mutations, daemon shutdown,
port-holder killing, generic HTTP forwarding, and offline queued commands.

**No longer excluded, and this is a real widening.** v1 refused raw terminal
input and output, terminal creation and arbitrary shell by name. v2 offers all
three, each behind its own capability so a machine can grant them separately —
and `terminal.shell` is genuinely arbitrary command execution, gated by
`NOMOREIDE_REMOTE_SHELL` on the machine and off the advertised set when that is
off. While it is advertised, "remote control cannot run arbitrary commands" is
false, and the pairing copy says so rather than keeping a promise the code
stopped making.

**The read-only inspection surface.** The last seven rows above answer "what is
going on?" and change nothing: GitHub Actions runs and their jobs, pull
requests, what Claude and Codex have spent, the error inbox, and the runtime
timeline. They arrived after v2 shipped and needed no version bump, which is
what capabilities are for — a daemon advertises what it has, and a name an
older platform has not heard of is an omission rather than a failure.

Three rules held while adding them, and they are why this is not a widening:

- **No mutation.** There is no re-run, cancel, dispatch, merge, create, review
  or dismiss anywhere in it. The local product has all of those; they stay in
  `nomoreide-actions`, behind a person at the machine.
- **A phone names what to look at, never where.** No payload carries a
  repository, an owner, a path or a working directory — the daemon answers for
  the repository and workspace it already has selected. A general-purpose GitHub
  client running under the user's token is a much larger thing than "show me my
  CI", and the wire types have nowhere to express it.
- **The sanitized shapes drop what the local ones carry.** An incident crosses
  without its log excerpt (raw service output, which the log capability redacts
  separately) and with the *basename* of its file rather than the path. A
  timeline entry crosses without its `data` blob, which for a process event is a
  pid, an exit code and a command line. Agent usage crosses without the working
  directory and session id the local panel shows. A pull request crosses without
  its body.

The one thing that does cross and names the outside world is a **`github.com`
URL** on a run, a job and a pull request — validated to that host, because it is
the field a phone puts in front of somebody to tap. Without it a red run on a
phone is a dead end.

## Events — daemon → platform

| `type` | `replyTo` |
| --- | --- |
| `session.hello` | absent |
| `session.heartbeat` | absent |
| `device.snapshot.response` | required |
| `service.list.response` | required |
| `service.action.response` | required |
| `service.logs.response` | required |
| `bundle.list.response` | required |
| `agent.providers.response` | required |
| `agent.turn.accepted` | required |
| `agent.turn.event` | absent |
| `terminal.spawned` | required |
| `terminal.sessions.response` | required |
| `terminal.attach.accepted` | required |
| `terminal.ack` | required |
| `terminal.output` | absent |
| `terminal.geometry` | absent |
| `terminal.closed` | absent |
| `github.runs.response` | required |
| `github.run.jobs.response` | required |
| `github.prs.response` | required |
| `github.pr.response` | required |
| `agent.usage.response` | required |
| `errors.response` | required |
| `timeline.response` | required |
| `command.error` | required |

An answer that arrives with no correlation is one the relay would have to guess
a destination for, and guessing means fanning a private answer to the wrong
browser — so the rule is enforced, not assumed.

### Run events

`agent.turn.event` carries `runId`, a `seq` that is monotonic within the run
from `0` with no gaps, and one of: `text`, `toolUse`, `toolResult`,
`approvalRequest`, `approvalSettled`, `completed`, `cancelled`, `error`. The
last three are terminal.

Ordering is never inferred from arrival. A reconnecting client resumes from the
last `seq` it rendered; one whose `seq` is older than the replay buffer is told
to take a fresh snapshot rather than handed a gap it cannot detect.

### The terminal mirror

A mirror is a stream, not an exchange: `terminal.output`, `terminal.geometry`
and `terminal.closed` arrive on their own schedule long after the attach they
belong to was answered, so they carry no `replyTo` and are keyed by the
`streamId` the attach minted.

Bytes are base64 in JSON rather than binary WebSocket frames. It costs 33% and
buys one frame type, one parser and one validation story; PTY traffic is small
and bursty enough that the overhead is irrelevant beside the invariant.

**The viewer never sets the geometry.** A PTY has exactly one size and the
person at the desk owns it — a phone that resized it would reflow a terminal
somebody is working in. So `terminal.attach.request` states what the phone
*can* draw, `terminal.attach.accepted` answers with what it *will* be drawing,
and `terminal.geometry` says so again whenever the machine changes it. That last
frame is not a nicety: a TUI positions with absolute column escapes, so a viewer
still drawing into the grid it was told about at attach does not produce a
ragged margin, it produces characters landing on top of each other.

**Remote approval policy is fail-closed, and stated once:** `autoApprove` does
not exist remotely; an approval unanswered for 120 s denies itself; a run or
daemon that ends denies everything still pending; an unknown tool is treated as
mutating; there is no "always allow"; and the approval card shows provider, tool
name, **full** structured input, workspace and device — never a summary, because
a summary is what lets a hostile prompt get a destructive call approved by
making it look boring.

---

## Limits

| Limit | Value |
| --- | --- |
| Frame | 256 KiB |
| Agent prompt | 16 KiB |
| Log line | 8 KiB |
| Log lines per response | 200 |
| Log response | 256 KiB |
| Pending commands per device | 32 |
| Service command timeout | 30 s |
| Heartbeat interval | 25 s |
| Presence timeout | 75 s |
| Reconnect backoff cap | 30 s (jittered) |
| Request age | 60 s |
| Clock skew ahead | 300 s |
| Request-id dedup window | 600 s |
| Approval expiry | 120 s |
| Agent event replay | 300 s / 2048 events |
| Identifier length | 128 bytes |
| Workflow runs per response | 30 |
| Workflow jobs per response | 100 |
| Pull requests per response | 30 |
| Incidents per response | 50 |
| Timeline entries per response | 100 |
| Any single summary string | 512 bytes |
| Inspection response | 128 KiB |

All byte counts are UTF-8 bytes, not characters — a limit counted in characters
is a limit an attacker picks the units of.

---

## Error codes

`UNSUPPORTED_PROTOCOL_VERSION`, `MALFORMED_FRAME`, `UNKNOWN_COMMAND`,
`FRAME_TOO_LARGE`, `PAYLOAD_TOO_LARGE`, `STALE_REQUEST`, `DUPLICATE_REQUEST`,
`TOO_MANY_PENDING`, `NOT_AUTHORIZED`, `DEVICE_OFFLINE`, `UNKNOWN_SERVICE`,
`SERVICE_ACTION_FAILED`, `UNKNOWN_RUN`, `UNKNOWN_APPROVAL`, `APPROVAL_EXPIRED`,
`TIMEOUT`, `RATE_LIMITED`, `CAPABILITY_UNAVAILABLE`, `INTERNAL_ERROR`.

A code a peer does not recognise reads as `INTERNAL_ERROR`, so a code added in a
later revision cannot break an older client.

**Only three are retryable:** `TOO_MANY_PENDING`, `RATE_LIMITED`,
`DEVICE_OFFLINE` — the ones refused before anything ran. Everything else is not,
`TIMEOUT` above all: the daemon may yet finish what timed out.

`retryable` is repeated on the wire so a peer that does not know the code still
knows what to do with it. **A peer that does know the code must trust its own
table over the field** — otherwise a hostile relay could mark a timeout
retryable and drive a double mutation.

---

## Idempotency

The request `id` is the idempotency key. A mutation executes at most once per
id, within the 600 s dedup window.

| Seen before? | Read | Mutation |
| --- | --- | --- |
| never | execute | execute |
| still running | execute | **refuse** |
| finished, answer cached | execute | replay the recorded answer |
| finished, answer lost | execute | **refuse** |

**No layer of this system automatically re-sends a mutation whose outcome it
does not know.** `restart the database` twice is a different outcome from
`restart the database` once, and no amount of care at the call site prevents it
if the transport is allowed to be helpful. Ambiguity escalates to a human
looking at the machine's real state, which is exactly what a phone is good for.

---

## Version skew

The revision to the relay plan asked for this to be decided before building.
It is decided here.

**Evidence it matters:** this project's own development machine ran a v0.1.103
daemon against a v0.3.0 client for days, and the only signal was one warning
line. People do not upgrade daemons promptly, so "the versions differ" is the
normal case.

- **Unknown command → error.** Fail closed, in both directions.
- **Unknown capability → omission.** A feature the other end has not got is a
  thing to *say* (`CAPABILITY_UNAVAILABLE`), not a thing to fail on. The phone
  renders "your machine is running an older NoMoreIDE"; the rest of the session
  keeps working.
- **Negotiation** takes the highest major both peers list.
- **No shared version, peer at or above the floor → degraded session.**
  Presence and read-only commands route; every mutating command is refused with
  `UNSUPPORTED_PROTOCOL_VERSION`. Refusing the whole session instead would leave
  a dead screen with no way to tell the user what to do about it.
- **Below the floor → the socket is refused outright.**

New features ship as capabilities, not version bumps. A version bump is for a
change that breaks the payload union, and it costs every stale daemon a degraded
session — which is the cost that should make it rare.

---

## Threat model checklist

Each row is a thing that will happen, and the property that has to hold when it
does. The end-to-end release gate in the relay plan exercises the starred ones.

| Threat | What must hold |
| --- | --- |
| **Platform account compromise** | The attacker reaches only the allowlist. No shell, no filesystem, no git, no database, no credential read — because no frame can express them. Approvals still require a per-call human decision on the phone that was compromised, which is the residual risk, and is why the approval card shows full tool input. |
| **Device credential theft** | The credential authenticates a socket, not a user. It cannot claim ownership, list devices, or read platform data. Revocation ★ closes the socket and refuses reconnect on the platform's own authority; a daemon ignoring `session.revoke` must still be unable to act. |
| **Orphaned daemon** ★ | Eight were alive on one developer machine on 2026-09-01, the oldest two days old, one serving a pre-port version. An orphan holds a credential and an outbound socket, so revocation must not depend on it cooperating, credential lifetime binds to the daemon's runtime lock, and `nomoreide remote status` must show every live daemon it can see. |
| **Replay** | `sentAt` bounds a frame to 60 s of relevance; the request id deduplicates inside 600 s; and a mutation whose answer is lost refuses rather than re-running. The dedup window deliberately outlasts the staleness window, so a frame young enough to execute is always young enough to have been seen. |
| **Hostile or compromised relay** | The daemon validates every frame itself and is the final authority. It never trusts the relay's `retryable`, never proxies arbitrary `/api/*`, and refuses commands outside the allowlist even when perfectly framed. |
| **Hostile daemon** | The platform refuses unknown events just as exhaustively. Sanitized wire structs have nowhere to put a command line, a path, an environment or a pid, so a daemon cannot publish them into a browser. |
| **XSS on the hosted frontend** | Machine control raises what an XSS costs. Long-lived refresh credentials must not sit in `localStorage` before broad rollout — that is a rollout gate in the relay plan, not a nice-to-have. |
| **Malicious local page** | The daemon's local credential is a bearer token in a header, not a cookie, so a page in the user's browser cannot ride along with ambient authority. The relay adds no inbound port and no new local origin. |
| **Relay restart** ★ | Presence fails closed: a missed heartbeat window marks the device offline and *suspends* routing rather than queuing. Reconnecting clients discard optimistic state and re-snapshot. No mutation survives a restart to execute afterwards. |
| **Version skew** | Stated above. A stale daemon degrades to read-only and the user is told; it never silently half-works. |
| **Resource exhaustion** | Frame, prompt, log and pending-command limits are checked before the work they bound. The frame length is checked before a byte is parsed. |

---

## Golden fixtures

`crates/nomoreide-remote-protocol/src/fixtures/`

```
valid/device-bound/<type>.json        one frame per command
valid/platform-bound/<type>.json      one frame per event, and per run-event kind
invalid/<case>.json                   self-describing rejection cases
```

A valid fixture is a whole frame. An invalid fixture is a small object that
names what it is testing:

```json
{
  "note": "why this frame is refused",
  "direction": "deviceBound",
  "expect": "UNKNOWN_COMMAND",
  "frame": { "...": "the frame, when it is valid JSON" },
  "frameText": "the frame as raw bytes, when it is not"
}
```

Exactly one of `frame` and `frameText` is present. There is no manifest: the
harness walks the directory, so a fixture cannot be committed and left
unexercised.

**Four assertions run against this directory:**

1. every valid frame parses, and re-encoding it reproduces the file byte for
   byte;
2. every invalid frame is refused with exactly the code it names, and with the
   `retryable` that code's own table gives;
3. the samples cover every `type` in both unions and every run-event kind;
4. no committed frame is left behind by a rename.

The valid half is generated from the Rust sample set:

```bash
UPDATE_REMOTE_FIXTURES=1 cargo test -p nomoreide-remote-protocol fixtures
```

They are also the source for any mirror written in another language. The hosted
frontend will eventually render run events over SSE, and its TypeScript types
should be checked against these bytes rather than against a reading of this
document.

Doing that is a protocol change. The diff is the review.

These are **not** parity recordings, and no parity gate covers the relay. The
policy in `CLAUDE.md` stands: recordings are a decaying asset, no new ones are
added, and the relay has no TypeScript counterpart to have recorded anyway. What
protects it is native Rust tests, this fixture set, and the end-to-end release
gate in the relay plan.

---

## How the platform depends on it

`nomoreide-remote-protocol` publishes to crates.io from the same tag as the
other seven, first in dependency order. Two consequences worth writing down:

- **Its trusted publisher has to be configured before the release that first
  publishes it**, per `CLAUDE.md`. A new crate with no trusted publisher fails
  the `crates` job at the end of a release, after the GitHub Release already
  exists.
- **The platform can only pick up a protocol change at publish time**, unless it
  takes a git dependency on a branch during development. Prefer publishing: a
  git dependency that tracks `main` makes the platform's build depend on
  whatever was merged this morning, which is exactly the version skew this
  document exists to make deliberate.
