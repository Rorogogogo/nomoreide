# nomoreide-core

The stateful backbone: service configuration, process supervision, log storage, git, agents, databases and provider integrations.

Part of [NoMoreIDE](https://github.com/Rorogogogo/nomoreide) — an AI-native
service workbench that exposes one core through a CLI, a TUI, a web dashboard
and an MCP server for AI agents.

The process manager only ever kills what it spawned — a foreign process holding a conflicting port is reported, never terminated. `git_manager` is read-safe by construction: it has no `reset --hard`, `clean`, force-push or `branch -D`.

## Installing the product

This crate is a component. To install the tool itself:

```bash
cargo install nomoreide-cli      # or: curl -fsSL https://www.nomoreide.com/install.sh | sh
```

## License

AGPL-3.0-only. A commercial license is available — see
[COMMERCIAL.md](https://github.com/Rorogogogo/nomoreide/blob/main/COMMERCIAL.md).
