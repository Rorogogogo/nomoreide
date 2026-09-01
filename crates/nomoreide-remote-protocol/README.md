# nomoreide-remote-protocol

The frozen wire protocol for [NoMoreIDE](https://www.nomoreide.com) remote
control: what a phone may ask a local daemon to do, through the hosted relay,
and the rules for refusing everything else.

Two independently deployed programs speak it — the `nomoreide` daemon on a
developer's machine and the hosted platform's API — so it lives in a package of
its own rather than inside either. It has three dependencies (`serde`,
`serde_json`, `chrono`) and talks to no socket, no service and no agent.

The contract, including the threat model, is
[`docs/remote-protocol-v1.md`](https://github.com/Rorogogogo/nomoreide/blob/main/docs/remote-protocol-v1.md).

## What it is for

- `device_bound` — every command the platform may send. This union **is** the
  remote attack surface: eleven names, none of which can carry a shell command,
  a path, an environment, a port or a process id.
- `platform_bound` — every event a daemon may send, in sanitized shapes with
  nowhere to put the fields that must not leave the machine.
- `envelope` — the invariant frame, and the order a frame is checked in.
- `limits`, `errors`, `version`, `idempotency` — the numbers, the refusal codes,
  what happens when the two ends are different ages, and why a mutation is never
  automatically re-sent.
- `fixtures` — one sample of every frame, embedded, so an independent
  implementation can check itself against the same bytes.

Licensed AGPL-3.0-only, or commercially — see
[COMMERCIAL.md](https://github.com/Rorogogogo/nomoreide/blob/main/COMMERCIAL.md).
