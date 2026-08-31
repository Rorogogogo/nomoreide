# nomoreide-actions

The guarded write surface — the operations deliberately kept out of the read-safe modules.

Part of [NoMoreIDE](https://github.com/Rorogogogo/nomoreide) — an AI-native
service workbench that exposes one core through a CLI, a TUI, a web dashboard
and an MCP server for AI agents.

NoMoreIDE splits reads from writes on purpose. Anything an AI agent can reach is read-safe; pushes, commits, database writes and deploy actions live here instead, behind human-facing guards such as per-connection unlock and affected-row previews.

## Installing the product

This crate is a component. To install the tool itself:

```bash
cargo install nomoreide-cli      # or: curl -fsSL https://www.nomoreide.com/install.sh | sh
```

## License

AGPL-3.0-only. A commercial license is available — see
[COMMERCIAL.md](https://github.com/Rorogogogo/nomoreide/blob/main/COMMERCIAL.md).
