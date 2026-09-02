# Operating the remote control relay

What to do when something is wrong, and what to check before turning it on for
more people. Written for whoever is holding the pager, which for now is one
person.

## The shape of it, in one paragraph

A user runs `nomoreide remote pair` on their machine. The daemon dials **out** to
`api.nomoreide.com` over TLS and holds one WebSocket. The platform holds that
socket in memory, in the same `api` container that serves the profile registry.
A phone sends REST commands, the relay turns them into protocol frames, and the
daemon executes them **through its own local HTTP router** against an explicit
allowlist. Nothing listens on the user's machine; nothing about a device's
presence is durable.

---

## Kill switches

Two, deliberately independent, because the two sides fail for different reasons.

**Platform** — `REMOTE_RELAY_ENABLED=false`, then redeploy.

The routes are not *mounted*, so the API answers `404`, not `403`. A relay taken
out of service should look like one that was never there rather than one that is
broken — a phone showing "not found" prompts a reload, and one showing "refused"
prompts a support ticket. Every connected daemon drops on the restart and
reconnects into a 404, backing off to a poll every 30 seconds.

**One machine** — `NOMOREIDE_REMOTE_DISABLED=1`, then restart its daemon.

Local, immediate, and does not unpair: the credential survives, so turning it
back on is one restart rather than a second pairing. Use this to take one
machine out of the picture while debugging it.

Neither switch revokes anything. See below for that.

---

## Revoking a device

**This is the emergency procedure.** It is also the only one that survives a
daemon that is not cooperating.

1. The owner opens `/app/remote/<device>` and taps **Revoke this machine**, or
   `DELETE /remote/devices/{id}` with their session.
2. The row is written **first**, then the socket is closed. That order matters:
   a daemon that reconnects in the gap is refused by the credential check, where
   closing first would leave a window for it to come straight back.
3. The daemon is answered `401` on its next connect, recognises a refusal as
   different from a dropped connection, and **stops trying**. It prints how to
   pair again and keeps serving locally.

Revocation is permanent and one-way. There is no un-revoke, because a credential
that can be reinstated is one an attacker only has to wait out.

**If the owner cannot reach the UI**, revoke in the database and restart the API
— the socket is in that process's memory, so a restart drops every device and
the revoked one is refused when it comes back:

```sql
UPDATE remote_devices SET revoked_at = NOW() WHERE id = '<device>' AND revoked_at IS NULL;
```

To revoke everything for one account, drop the `AND id =` clause and use
`owner_user_id`.

---

## Single replica

**The API must run as one replica while the relay is enabled.** Device sockets
are held in the process that accepted them, so two replicas would each know half
the devices and neither would know it — a phone would reach its machine only when
its REST request happened to land on the right one.

This is logged at startup on every boot, and it is not enforced anywhere, because
the thing that would enforce it is the thing that removes the need for it. When
this stops being acceptable — more replicas, deploys disconnecting devices
becoming intolerable, socket load hurting REST latency, regional routing — the
relay plan's extraction triggers apply: the same `RelayHub` contract moves into
its own process with Redis for ephemeral presence and routing, and Postgres stays
the authority for ownership, credentials, revocation and audit.

---

## What a deploy does

Restarting the API drops every device socket. Daemons reconnect with jittered,
capped backoff, so they come back spread over about thirty seconds rather than
all at once.

**No mutation survives a restart.** Pending commands live in the process that
was waiting for them; when it goes, the browser's request fails and the phone
shows an error. That is by design: a command that survived a deploy and executed
afterwards would be a restart the user asked for twenty minutes ago arriving
while they are doing something else.

Presence fails closed. After a deploy every device reads offline until its daemon
reconnects — the database's `last_seen_at` is a historical note, never a claim
that a machine is reachable now.

---

## Triage

| Symptom | Where to look |
| --- | --- |
| A machine shows offline but its daemon is running | Its `NOMOREIDE_API_BASE_URL` — a credential is only valid against the deployment that issued it, and `nomoreide remote status` says so plainly when the two disagree. |
| A machine shows offline and its daemon exited the relay | The daemon prints why. `credential refused` means revoked; anything else is transport and it is still retrying. |
| A command answers "not connected right now" | The socket is gone. Presence is in-memory, so this is the truth as of this instant, not a stale row. |
| A command answers "does not support that yet" | The daemon advertised no such capability. Usually an older build; `daemon_version` on the device page says which. |
| A command times out | **Do not retry it.** A timeout says nothing about whether the machine did the work. Check the machine. |
| Every device went offline at once | The API restarted. They will be back within ~30s. |
| Pairing codes stop being accepted | The per-user claim limit is 10/minute. It is deliberately the tightest limit in the system. |

---

## Rollout order

Turn it on for widening groups in this order, which is the order of increasing
consequence — each step is safe to stop at:

1. **Presence** — devices appear, nothing can be commanded.
2. **Read-only service status** — the list, no buttons.
3. **Service actions** — start, stop, restart.
4. **Logs** — the first feature that carries machine output off the machine.
5. **Agent text** — turns that only read.
6. **Approvals** — turns that can change things.

There is no per-capability flag on the platform: the gate is what the *daemon*
advertises, so a step is taken by shipping a daemon that advertises more. That
keeps the decision with the code that has to honour it.

---

## Before widening past yourself

- **Hosted auth storage.** Long-lived refresh credentials must not sit in browser
  `localStorage` before this reaches more people. Machine control raises what an
  XSS costs from "read this user's profiles" to "restart this user's database".
  This is a rollout gate, not a nice-to-have.
- **Orphaned daemons are the norm.** Eight were alive on one developer machine on
  2026-09-01, the oldest two days old, one from before the Rust port. Every
  release gate should include: revoke a device while a deliberately orphaned
  daemon is still running, and prove it cannot act.
- **Rate limits die with the process.** They are in memory, so a deploy resets
  them. An attacker who times a run to a deploy gains one window. Acceptable at
  one replica; it moves to Redis with the hub.
