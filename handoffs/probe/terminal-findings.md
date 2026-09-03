# Terminal probe findings (reference, run 2026-08-24)

Probed with `handoffs/probe/terminal-probe.ts` against a throwaway-home
reference daemon. Nothing below is read from the TypeScript.

## Note: node-pty's spawn-helper loses its executable bit

First run produced `state: "error"`, `error: "posix_spawnp failed."` for every
session. `node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper` was 644.
`chmod 755` fixed it. The reference carries `repairNodePtySpawnHelper()` for
exactly this. A gate that creates sessions must not depend on the bit being
set — or must repair it first.

## The three tools are daemon passthroughs

| tool | request |
| --- | --- |
| `nomoreide_list_terminal_sessions` | `GET /api/terminal/sessions` → `.sessions` |
| `nomoreide_open_terminal` | `POST /api/terminal/sessions/{id}/open-system-terminal` → `.session` |
| `nomoreide_reclaim_terminal` | `POST /api/terminal/sessions/{id}/reclaim-dock` → `.session` |

Both POSTs carry `x-nomoreide-terminal-control: 1`; without it the route is 403.
The id is percent-encoded into the path.

## Payloads

Empty list is `[]` (not `{"sessions": []}`). A session renders with this key
order, which the gate must hold with an explicit `JSON.stringify` compare:

```
id, cols, cwd, [error], [exit], kind, [label], [provider], rows, shell, state, presentation
```

`presentation` is appended by the manager after the session's own snapshot, so
it is always last. `error`/`exit`/`label`/`provider` are omitted when absent.

## Refusals reached without launching Terminal.app

- unknown id, both tools: `Unknown terminal session: <id>` (isError)
- non-agent session, open: `Only agent sessions can open in Terminal.`
- non-agent session, reclaim: **succeeds**, returns the session unchanged with
  `presentation: "dock"`. Reclaim does not check kind or state — it resets
  whatever it finds and reports it.
- `nomoreide_reclaim_terminal` on an unknown id is a 404 from the route, which
  the tool reports with the same wording as open's manager-thrown error.

## Argument validation (JSON-RPC -32602, before the tool runs)

- `id: ""` → `id: String must contain at least 1 character(s).`
- `id: "a/b"` → `id: Invalid input.`
- missing `id` → `id: Required.`
- an undeclared key on `list_terminal_sessions` is stripped, not rejected.

## What a session is, and who makes one

No MCP tool creates a session. `POST /api/terminal/sessions` does, and it is the
only creator:
- `{}` → a plain workspace shell, `kind: "shell"`, id `term_<n>` (a counter).
- `{ serviceName }` → `kind: "service"`, id `svc:<name>` (stable, so reopening
  reattaches).
- `{ agent: { provider, prompt, ... } }` → `kind: "agent"`, `provider` set.

Sessions live in daemon memory only — nothing is written to disk, so a gate
cannot plant one and must drive this route.

## Not reachable from a gate

`open_terminal` on a *running agent* session really launches Terminal.app. The
paths behind that launch — `terminalLaunching`, the lease, "already opening or
active in Terminal", the attach/detach socket protocol — cannot be compared
without taking over the developer's desktop. Every other refusal is reachable:
an agent session whose stub binary has exited yields `Only a running agent
session can open in Terminal.`
