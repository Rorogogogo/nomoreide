# Remote control relay plan — after native Rust cutover

**Status:** Planning. The dependency gate below is **met** as of 2026-09-01 —
see "Revised after the Rust port" at the end of this document, which supersedes
parts of the text above. Read that section before implementing.

**Goal:** Let an authenticated user control registered local services and interact with local agents from a phone through the hosted NoMoreIDE platform, without opening an inbound port on the user's machine.

## Dependency gate

Relay implementation begins only when all of these are true:

- the native `nomoreide daemon` is the canonical owner of services, logs, terminals, agent runs, and approvals;
- the Node.js daemon is no longer required for the active runtime path;
- local service actions and agent approvals have typed Rust APIs and fail-closed tests;
- the native release/installer can update the daemon safely;
- daemon state and credential files use atomic mode-`0600` storage;
- the daemon has an explicit shutdown lifecycle for sockets, child processes, runs, and pending approvals.

## MVP architecture decision

Reuse the existing hosted Axum API container and PostgreSQL database. Add the relay as an isolated in-process Rust module with a narrow `RelayHub` interface. Do not add Redis or a second service for the first release.

```text
Phone browser
  |-- authenticated HTTPS commands -----> existing Axum API
  |-- authenticated SSE agent/events ---> existing Axum API
                                                |
                                         in-memory RelayHub
                                                |
                                      one outbound device WSS
                                                |
                                      native nomoreide daemon
                                                |
                              services / logs / agents / approvals
```

Why this boundary:

- the platform already owns users, sessions, authorization, Axum composition, Postgres, Docker, and Caddy;
- production currently runs one API replica, so in-memory socket routing is sufficient;
- browser REST and SSE reuse the existing bearer-auth client and avoid a second browser socket-token system;
- the module boundary permits later extraction without changing the device protocol.

Split the relay into a separate process and introduce Redis/NATS only when multiple API replicas, deploy isolation, connection scale, or regional routing makes it necessary.

Use `/app/remote/:deviceId` for the MVP. Do not add per-device `xx.nomoreide.com` hostnames yet; wildcard DNS/TLS, hostname ownership, cookie origins, renaming, and information leakage add complexity without improving control behavior.

## Trust boundaries

- The daemon always initiates the outbound TLS WebSocket. No router configuration, port forwarding, tunnel, or public bind is required.
- The platform authorizes which user owns a device.
- The relay routes only versioned, validated messages.
- The daemon independently validates the message and is the final authority over available local operations.
- Never proxy arbitrary local `/api/*` routes.
- Never send the user's platform refresh token to the daemon.
- Never persist prompts, agent output, tool input/results, log bodies, terminal data, environment variables, or local credentials in the platform database.

## Pairing and device credentials

1. `nomoreide remote pair` asks the platform to create a ten-minute pairing session.
2. The platform returns an opaque pairing secret, a human code such as `ABCD-EFGH`, and a verification URL/QR payload.
3. The user opens the URL on the phone, signs in normally, reviews the proposed machine name/platform, and claims the code.
4. The daemon polls with the opaque pairing secret and exchanges it exactly once for a random 256-bit device credential and device ID.
5. PostgreSQL stores only hashes of pairing secrets, user codes, and device credentials.
6. The daemon stores the credential outside general config in a dedicated mode-`0600` remote credential file.
7. Revocation immediately rejects the device socket and future reconnects.

Pairing codes are case-insensitive Crockford Base32, single-use, attempt-limited, and rate-limited by IP and user. Claim/exchange must be transactional so two callers cannot consume the same pairing.

Public platform routes:

```text
POST   /remote/pairing-sessions             device creates pairing
GET    /remote/pairing-sessions/:id         device polls with pairing secret
POST   /remote/pairing-sessions/claim       signed-in user claims code
POST   /remote/pairing-sessions/:id/exchange device consumes credential
GET    /remote/devices                      signed-in user lists devices
GET    /remote/devices/:id                  owner reads metadata/presence
PATCH  /remote/devices/:id                  owner renames device
DELETE /remote/devices/:id                  owner revokes device
GET    /remote/devices/:id/events           authenticated SSE stream
POST   /remote/devices/:id/commands         authenticated typed command
GET    /remote/ws/device                    device-token WebSocket upgrade
```

## Persistence

Reuse the existing Postgres instance and migration system, but create remote-specific tables.

### `remote_devices`

- `id UUID PRIMARY KEY`
- `owner_user_id UUID REFERENCES users`
- `name TEXT`
- `credential_hash BYTEA`
- `daemon_version TEXT`
- `protocol_version INTEGER`
- `platform TEXT`
- `capabilities JSONB`
- `created_at`, `updated_at`, `last_seen_at`, `revoked_at`

### `remote_pairing_sessions`

- `id UUID PRIMARY KEY`
- `user_code_hash BYTEA UNIQUE`
- `pairing_secret_hash BYTEA UNIQUE`
- proposed device metadata
- `claimed_by_user_id`, `claimed_at`
- `device_id`, `exchanged_at`
- `expires_at`, `created_at`

Reuse the platform's existing audit log for pairing, rename, revoke, and sanitized command outcomes. Record request ID, device, actor, command kind, service name where applicable, result code, and latency. Do not store command bodies or agent content.

Presence and pending requests stay in memory. Throttle durable `last_seen_at` updates to avoid a write per heartbeat.

## Versioned device protocol

Use a strict discriminated JSON envelope over the daemon WebSocket:

```json
{
  "v": 1,
  "id": "request-uuid",
  "type": "service.action.request",
  "deviceId": "device-uuid",
  "sentAt": "2026-08-20T00:00:00Z",
  "replyTo": null,
  "payload": {}
}
```

Maintain one canonical schema and golden valid/invalid fixtures used by both repositories. Generate or verify Rust and TypeScript types from the same fixture set. Reject unknown major versions, message types, fields where strictness matters, oversized frames, invalid device IDs, and stale requests.

Relay limits for the MVP:

- 256 KiB maximum device frame;
- 16 KiB maximum agent prompt;
- 8 KiB maximum individual log line;
- 200 log lines and 256 KiB maximum log response;
- 32 pending commands per device;
- 30-second service command timeout;
- heartbeat every 25 seconds, offline after 75 seconds;
- reconnect with exponential backoff and jitter, capped at 30 seconds;
- request IDs act as idempotency keys; ambiguous mutations are never retried automatically.

## Exact MVP capability allowlist

### Device and service control

- sanitized device snapshot and online/offline status;
- registered service names, descriptions, kinds, ports, and runtime states;
- registered bundle names and states if bundle parity is already stable;
- `start`, `stop`, and `restart` for an exact registered service;
- bounded, redacted recent logs for an exact registered service.

The remote request cannot supply a command, argument, working directory, environment, port override, SSH host, process ID, or kill strategy. `killHolder` is not remotely available.

### Agent interaction

- query available agent providers/capabilities;
- start or resume one agent turn in the daemon's selected workspace;
- stream structured text, tool-use, tool-result, approval, completion, cancellation, and error events;
- cancel an active turn;
- allow or deny one pending mutating tool request.

Remote policy is always fail-closed:

- `autoApprove` is false;
- approvals expire after 120 seconds and default to deny;
- daemon shutdown, run completion, or lost relay ownership denies unresolved approvals;
- no permanent “always allow” decision exists remotely;
- unknown tools are treated as mutating;
- the approval UI shows provider, tool name, full structured input, device, and workspace rather than a vague summary.

Codex write-capable remote turns remain unavailable until its native runtime adapter can provide the same approval guarantees as Claude. Read-only support may ship earlier if clearly labeled.

### Explicitly excluded from MVP

- raw terminal input/output or terminal creation;
- arbitrary shell commands;
- filesystem browsing or file writes;
- Git mutations;
- database queries or write unlock;
- service/config registration changes;
- environment or credential reads;
- provider/deployment mutations;
- daemon shutdown;
- port-holder killing;
- generic HTTP forwarding;
- offline queued commands.

## Local native repository implementation map

Add these modules to the Rust workspace created by the migration plan:

```text
crates/nomoreide-core/src/remote/
  protocol.rs          strict envelopes, capabilities, limits, error codes
  credentials.rs       atomic local device credential storage
  pairing.rs           pairing lifecycle and platform REST client
  connector.rs         outbound WSS, heartbeat, reconnect, shutdown
  dispatcher.rs        exhaustive allowlisted command dispatch
  service_control.rs   sanitized snapshots/actions/log reads
  agent_runs.rs        run IDs, event sequence/ring buffer, cancellation
  redaction.rs         ANSI/control/credential sanitization
```

The dispatcher receives the same canonical service manager, log store, agent run manager, and approval broker used by local MCP/web/Tauri clients. ~~It calls core APIs directly rather than looping through the localhost HTTP router.~~

> **Reversed 2026-09-01 — see "Revised after the Rust port" below.** Calling core
> directly makes the relay a fifth dispatch surface, which is the mistake the
> Tauri crate already made and is still paying for. Route through the daemon's
> own router in-process, against an allowlist.

Add `nomoreide remote pair|status|unpair` to the native CLI. The local dashboard may show pairing and connection state, but it must never return or render the device credential.

## Platform backend implementation map

In `nomoreide-platform`:

```text
backend/migrations/<timestamp>_remote_control.sql
backend/crates/domain/src/remote/{mod.rs,entity.rs,repository.rs}
backend/crates/application/src/remote/{mod.rs,commands.rs,service.rs}
backend/crates/infrastructure/src/repositories/remote_pg.rs
backend/crates/api/src/remote/{mod.rs,protocol.rs,hub.rs,device_socket.rs}
backend/crates/api/src/http/dto/remote.rs
backend/crates/api/src/http/handlers/remote.rs
backend/crates/api/src/http/routes/remote.rs
backend/crates/api/src/http/extractors/current_device.rs
```

Modify `backend/crates/api/src/app.rs` to inject the repository, application service, and one in-memory `RelayHub`. Register routes through the existing router composition and document REST routes in OpenAPI. Keep the WebSocket protocol in its own schema document.

`RelayHub` responsibilities:

- at most one active daemon socket per device; a newly authenticated connection replaces a stale one;
- ownership check before every browser command or subscription;
- correlation of pending request IDs to device responses;
- SSE fan-out of device status and agent events;
- bounded buffers and backpressure;
- timeout/cancellation cleanup;
- online/offline presence;
- sanitized audit start/completion.

The single-replica constraint must be visible in deployment documentation and startup logs.

## Hosted frontend implementation map

In `nomoreide-platform/frontend`:

```text
src/lib/api/remote.ts
src/lib/remote/protocol.ts
src/features/remote/device-list-page.tsx
src/features/remote/pair-device-page.tsx
src/features/remote/device-page.tsx
src/features/remote/service-control-panel.tsx
src/features/remote/agent-panel.tsx
src/features/remote/approval-card.tsx
src/features/remote/use-device-events.ts
```

Add protected routes:

```text
/app/remote
/app/remote/pair
/app/remote/:deviceId
```

Use normal authenticated REST for commands and `fetch`/SSE for live events. On reconnect, discard optimistic live state and request a fresh device snapshot. Suspend status polling while offline. Phone layouts must keep stop/restart and approval actions deliberate, labeled, and resistant to accidental taps.

Before broad rollout, harden the hosted auth storage model so long-lived refresh credentials are not left in browser `localStorage`; machine control raises the consequence of an XSS compromise.

## Delivery phases

### Phase 1 — Protocol and threat boundary

- Freeze command/event unions, limits, error codes, idempotency, and golden fixtures.
- Implement exhaustive unknown-command rejection on both platform and daemon.
- Add a threat-model checklist for account compromise, device-token theft, replay, XSS, malicious local pages, and relay restart.

### Phase 2 — Persistence and pairing

- Add migration, domain/application/repository layers, pairing endpoints, ownership checks, revoke, and audit.
- Test expiry, brute-force limits, duplicate claim, wrong secret, replayed exchange, cross-user access, and revoked credentials.

### Phase 3 — In-process relay and Rust daemon presence

- Add `RelayHub`, device WebSocket authentication, heartbeat, reconnect, and sanitized snapshot/status.
- Deploy behind the existing Caddy/API container and run a one-hour idle-connection test.
- Confirm API restart makes clients reconnect but never replays a mutation.

### Phase 4 — Service control and logs

- Add exact-name status/start/stop/restart and bounded redacted logs.
- Add phone service cards and clear online/offline/error states.
- Prove no protocol payload can reach arbitrary command, config, terminal, database, Git, or kill-holder paths.

### Phase 5 — Agent runs and approvals

- Add daemon run manager with monotonically sequenced events and a bounded five-minute replay buffer.
- Add SSE translation, resume-after-sequence, cancellation, approval expiry, and disconnect cleanup.
- Add phone agent and approval UI.
- Test concurrent tabs, duplicate request IDs, slow consumers, reconnect, allow, deny, timeout, cancel, and daemon shutdown.

### Phase 6 — Hardening and staged rollout

- Add per-IP/user/device rate limits, metrics, structured logs, payload redaction tests, and operational dashboards.
- Feature-flag server routes and daemon remote connectivity independently.
- Canary in this order: presence → read-only service status → actions → logs → agent text → approvals.
- Publish incident response and immediate device-revocation procedures.

## Extraction triggers

Keep the relay in the existing backend until any of these becomes true:

- the API needs multiple replicas;
- API deployments disconnecting devices becomes operationally unacceptable;
- socket memory/CPU affects normal REST latency;
- independent autoscaling or regional relays are required.

Then extract the same `RelayHub` contract into a separate Rust binary/container and use Redis only for ephemeral presence, instance routing, one-use tickets, rate limits, and pub/sub. PostgreSQL remains the authority for ownership, credentials, revocation, and audit.

## End-to-end release gate

Using a production-like Docker platform and a native daemon on a separate network:

1. pair a device from a phone;
2. observe online status and a sanitized service snapshot;
3. start, restart, and stop a registered test service;
4. read bounded/redacted logs;
5. run an agent turn and receive ordered events;
6. allow one mutating tool request and deny another;
7. reconnect and resume from the last sequence;
8. revoke the device and prove its active socket closes and reconnect fails;
9. prove excluded commands are rejected by both relay and daemon;
10. restart the API and prove no stale mutation executes afterward.

The MVP is complete only when phone access cannot do anything outside this explicit allowlist, even if the hosted relay sends a malformed or hostile message.


---

# Revised after the Rust port

Written 2026-09-01, after the TypeScript→Rust port finished and v0.3.2 shipped.
Everything here supersedes the text above where they disagree.

## The dependency gate is met

| Gate | State |
| --- | --- |
| Native daemon owns services, logs, terminals, agent runs, approvals | ✅ `approval_broker.rs`, `agent_runtime.rs` in core |
| Node.js daemon no longer required | ✅ `src/` deleted; `check-no-node.sh` asserts 18 behaviours with node/npm/npx/tsx off PATH |
| Typed Rust APIs with fail-closed tests | ✅ 778 workspace tests; 65 parity gates |
| Native release/installer updates the daemon safely | ✅ `install.sh`, npm, crates.io, dmg — all on v0.3.2, `check-install.sh` 53/53 |
| State and credential files atomic, mode `0600` | ✅ `nomoreide-daemon/src/lib.rs`; asserted by `acquisition_clears_stale_state_and_publishes_private_runtime_files` |
| Explicit shutdown lifecycle | ✅ `serve_with_shutdown_requests`, signal forwarding — but see **Orphaned daemons** below |

**Implementation may begin.**

## 1. The dispatcher goes through the router, not around it

The plan above says the relay dispatcher should call core APIs directly
"rather than looping through the localhost HTTP router". **Do not implement it
that way.**

That is precisely what `crates/nomoreide-tauri` does, and this session measured
the bill: **150 `#[tauri::command]` functions, 7,555 lines**, duplicating what 43
daemon route modules already do. It drifts silently — the agent-environment
feature is a stub in the desktop app (`agent-env-tauri.ts`) because core gained
`agent_env` and the second dispatch surface never followed. Phase 1 of the
migration plan predicted exactly this for a third concurrent implementation;
the relay would be a fifth.

**The security property does not require the bypass.** "Never proxy arbitrary
local `/api/*` routes" is about *which* routes are reachable, not about how they
are invoked. Keep the allowlist — an explicit, exhaustive table of permitted
operations — and have each entry call the daemon's own router in-process
(`tower::Service`/`oneshot` against the assembled `Router`, not a loopback
socket). That gives:

- one implementation of what "restart a service" means, shared by browser, CLI,
  MCP, desktop and phone;
- the allowlist as a visible table rather than 40 hand-written call sites;
- the daemon's existing auth, validation and error shapes for free;
- a new feature reaching the phone with no relay change.

The relay's job is authorization, transport and shaping. It should not also be
an opinion about what a service action is.

## 2. Orphaned daemons are a security boundary, not housekeeping

The gate item "explicit shutdown lifecycle" assumes daemons exit cleanly. They
do not. Measured on one developer machine on 2026-09-01: **eight daemon
processes alive**, the oldest from two days earlier, one still serving v0.1.103
from before the port. This is a known, recurring condition — killed test runs
and crashed sessions leave daemons behind for days.

Today that is clutter. With remote control, an orphaned daemon holds a **device
credential and an outbound WSS**, so it keeps accepting phone commands after the
user believes it is gone — and it is the copy least likely to have been updated.

Required, beyond what the plan says:

- **Revocation must not depend on the daemon cooperating.** The platform closes
  the socket and refuses reconnect on its own authority; a daemon that ignores a
  revoke message must still be unable to act.
- **Credential lifetime is bound to the daemon's runtime lock**, not just to the
  file. A daemon that lost the lock must not keep a live relay session.
- **Presence fails closed.** A missed heartbeat window marks the device offline
  and suspends command routing rather than queuing.
- **`nomoreide remote status` must show every live daemon it can see**, so a
  user can discover the orphan they did not know about.
- Add to the release gate: *revoke a device while a deliberately orphaned daemon
  is still running, and prove it cannot act.*

## 3. Version skew needs a stated behaviour

The protocol is versioned, which is right, but the plan does not say what
happens on mismatch. Real evidence that this matters: this project's own
development machine ran a **v0.1.103 daemon against a v0.3.0 client for days**,
and the only signal was a one-line warning. Users do not upgrade daemons
promptly.

Decide and write down:

- what a phone on today's platform does when the daemon speaks an older protocol
  — refuse outright, or negotiate down to a capability subset;
- whether an unknown *capability* is an error or an omission (the answer should
  differ from an unknown *command*, which the plan already rejects exhaustively);
- how the phone surfaces "your machine is running an old NoMoreIDE" without
  making it look like a failure.

Prefer refusing mutating commands across a major protocol gap while still
allowing presence and read-only status — that keeps the "your machine needs
updating" message reachable instead of leaving a dead screen.

## 4. Testing: there is no reference to diff against

Every other surface in this repository was ported against a TypeScript
implementation, and 65 parity gates replay what it answered. **The relay has no
counterpart**, so none of that applies:

- Do not add recording-based parity gates for it. Recordings are a decaying
  asset — the policy in `CLAUDE.md` is that they are converted to native tests
  as they block change, and no new ones are added.
- The relay gets **native Rust tests** for protocol, allowlist exhaustiveness,
  redaction and dispatch, plus an **integration harness** that runs a real
  daemon against a real platform.
- Note explicitly: the parity suite will stay green through any relay
  regression. It is not the gate. The end-to-end release gate at the top of this
  document is.

## 5. Credentials must survive an upgrade

A device credential written by `nomoreide remote pair` has to outlive
`npm install -g nomoreide`, `install.sh` upgrades and `cargo install`.

This is not hypothetical: the port left agent configs pointing at
`node .../dist/index.js`, an entry point that no longer exists and that
`npm run build` no longer produces — so the MCP server failed to start on any
machine that pulled the new code, with no obvious cause. A stale remote
credential would fail the same silent way.

- Keep the credential in `~/.nomoreide/`, never in the checkout, never in
  `dist/`.
- `install.sh` and the npm postinstall must not clear it.
- `nomoreide remote status` should say plainly when a credential exists but the
  platform has revoked it, rather than reporting a connection error.

## What does not change

The rest of the plan holds and should be implemented as written: in-process
`RelayHub` over Redis, `/app/remote/:deviceId` over per-device hostnames,
outbound-only WSS with no inbound port, the explicit MVP allowlist and exclusion
list, the extraction triggers, the single-replica constraint being visible in
deployment docs, and hardening hosted auth storage before broad rollout.
