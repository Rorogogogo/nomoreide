# nomoreide-mcp

The stdio MCP server and its 70+ tools, grouped by domain.

Part of [NoMoreIDE](https://github.com/Rorogogogo/nomoreide) — an AI-native
service workbench that exposes one core through a CLI, a TUI, a web dashboard
and an MCP server for AI agents.

Everything exposed here is read-safe or scoped to services registered in configuration; there is no raw filesystem enumeration. Service-runtime tools go to the daemon over HTTP, while config, git, database and agent tools run in process.

## Installing the product

This crate is a component. To install the tool itself:

```bash
cargo install nomoreide-cli      # or: curl -fsSL https://www.nomoreide.com/install.sh | sh
```

## License

AGPL-3.0-only. A commercial license is available — see
[COMMERCIAL.md](https://github.com/Rorogogogo/nomoreide/blob/main/COMMERCIAL.md).
