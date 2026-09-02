# Remote terminal — protocol v2 stream channel

**Status:** Planning. Depends on remote control v1, which shipped in 0.4.0.

**Goal:** Let a paired phone attach to an **agent terminal already running on the
machine** — the real `claude`/`codex` CLI in its real pty — see what is on its
screen, and type at it. Not a reconstruction of the session; the session.

## Why not the approach v1 took

v1's agent panel drives `claude --print --output-format stream-json`
(`agent_runtime.rs:178`) — headless, one turn at a time, approvals brokered
through a `PreToolUse` hook. It works, and it is not what the product's own
terminal does. `terminal/agent.rs` + `spawn.rs` spawn the actual CLI in a
`portable-pty` with its full TUI, `--resume`, model selection, slash commands.
That is the thing people mean when they say "my agent". The phone should reach
*it*, not a second implementation of it — the same argument that made the relay
dispatcher route through the daemon's own router rather than calling core.

**The hook is not needed for this, and was a wrong turn in the design
discussion.** `PreToolUse` fires only on `Bash|Edit|Write|MultiEdit|NotebookEdit`
(`agent_runtime.rs:30`) and carries a tool name and input. It cannot see the
agent's prose, tool results, reads, or the screen — so it can never be the thing
that shows you the session, only a gate bolted beside one. Once the phone
mirrors the pty, an approval is answered by pressing the key you would press at
the desk, and the hook has nothing left to contribute. It also costs a `node`
dependency the CLI does not otherwise carry, and it is Claude-shaped, so it would
leave Codex sessions read-only.

Keep the hook available as a later, optional nicety: a tap-to-approve card is
kinder than hitting `y` on a phone. It is an upgrade on top of the mirror, not a
prerequisite, and nothing in this plan should wait for it.

## The line this draws, and where it is drawn

A pty carries whatever the child writes. There is no per-line egress filter for
it — `redact_line` (`dispatcher.rs:514`) works because logs are lines, and a
redraw stream has none. So **terminal bytes cross the wire unfiltered**, and
that is a change to what the product promises.

Two decisions contain it:

1. **Only `kind == "agent"` sessions are attachable remotely.** Sessions are
   already tagged `agent` / `shell` / `service` (`spawn.rs:58`, `service.rs:46`),
   and refusing non-agent sessions for an operation is an existing pattern
   (`session.rs:84`, `external.rs:59`) rather than a new idea. A shell session is
   arbitrary command execution, which is exactly what the pairing page promises
   remote control cannot do; an agent session is a program the user chose to run,
   whose approval prompts are its own. This keeps the promise true and still
   delivers what was asked for.
2. **It is its own capability.** `terminal.attach` is a separate allowlist row,
   so a user who wants service control from a phone but no terminal has that,
   and the advertised set says which they have.

The hub does not persist frames (`hub.rs` is in-memory, forward-only), so this is
transit rather than a new store. It is still a widening, and the pairing copy in
`pair-device-page.tsx` must stop saying "cannot run arbitrary commands" without
qualification.

## Protocol

v1 is frozen: request/response correlated by `request_id`, plus one one-way agent
event stream, `Envelope<T>` adjacently tagged, `MAX_FRAME_BYTES = 256 KB`. A pty
is continuous and bidirectional, so this is v2 — ordinary versioning, since
`SUPPORTED_VERSIONS` and `CapabilitySet` negotiation already exist.

New frames, both directions, all inside the existing envelope:

| Frame | Direction | Payload |
| --- | --- | --- |
| `terminal.sessions.request` | → device | (none) |
| `terminal.attach.request` | → device | `session_id`, `cols`, `rows` |
| `terminal.attach.accepted` | → platform | `stream_id`, `cols`, `rows` |
| `terminal.input` | → device | `stream_id`, `data` (base64) |
| `terminal.resize` | → device | `stream_id`, `cols`, `rows` |
| `terminal.detach` | → device | `stream_id` |
| `terminal.output` | → platform | `stream_id`, `seq`, `data` (base64) |
| `terminal.closed` | → platform | `stream_id`, `reason` |

**Base64 in JSON, not binary WebSocket frames.** It costs 33% and buys one frame
type, one parser, one dedup path, and no second validation story. Pty traffic is
small and bursty — an 80×24 repaint is roughly 2 KB — so the overhead is
irrelevant next to the invariant. Revisit only if measurement says otherwise.

Sizing and pacing, which are the difference between usable and a battery
complaint:

- coalesce reads on a ~16 ms timer rather than emitting a frame per `read()`;
- cap a coalesced chunk at 32 KB, well under `MAX_FRAME_BYTES`;
- bound the per-stream queue and **drop, then force a full repaint**, the way
  `EVENT_BACKLOG` already drops for events. A slow phone must never block the
  device socket.

## The gap that has to be closed first

`take_pending_output` (`manager.rs:795`) is one-shot: it drains what the child
printed before anyone listened, sets `streaming = true`, and retains nothing
after. So a phone that locks its screen and reattaches gets **a blank terminal
until the next byte arrives** — which, for an agent thinking quietly, could be a
long time.

This needs a bounded scrollback ring per session, replayed on attach. It is also
a local fix: the dashboard has the same hole on a websocket reconnect today.

## Phases

1. **Scrollback ring** in `terminal/manager.rs`, replayed on attach and on
   dashboard reconnect. Pure local win, ships on its own.
2. **Protocol v2** — the frames above in `nomoreide-remote-protocol`, version
   negotiation, fixtures for each, `KINDS` extended.
3. **Daemon side** — attach/input/resize/detach against the pty, agent-sessions-
   only, allowlist rows for `terminal.sessions` and `terminal.attach`, capability
   derivation as today.
4. **Hub** — stream forwarding with backpressure; revocation must tear down live
   streams, not only the socket.
5. **Phone UI** — xterm.js, a key row (enter / esc / arrows / y / n / ctrl-c),
   and `insert-prompt` retained for long text, since the wire prompt cap is 16 KB
   (`limits.rs`) against the local 512 KB.
6. **Docs and ops** — protocol doc, operations runbook, and the pairing copy.

## Tests that earn their keep

- A `shell` session refuses remote attach; an `agent` session accepts. Asserted
  against the allowlist, not a remembered check.
- Revocation closes an attached stream, not just the socket.
- A dropped/slow reader loses bytes and gets a repaint rather than stalling the
  device socket.
- Reattach after detach replays the ring and shows the current screen.
- Wire types still have nowhere to put cwd, env, pid, or command — the existing
  grep test extended to the new frames.
