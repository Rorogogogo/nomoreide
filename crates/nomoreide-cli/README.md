# nomoreide-cli

The `nomoreide` binary: argument parsing and every subcommand.

Part of [NoMoreIDE](https://github.com/Rorogogogo/nomoreide) — an AI-native
service workbench that exposes one core through a CLI, a TUI, a web dashboard
and an MCP server for AI agents.

Installs one executable that runs with no Node.js on the machine. Subcommands cover `mcp`, `setup`, `tui`, `web`, `daemon`, `git`, `db`, `agents`, `profile`, `list`, `logs`, `start`, `stop`, `restart` and `add`. `nomoreide setup` registers the MCP server with every AI agent it detects.

## Installing the product

This crate is a component. To install the tool itself:

```bash
cargo install nomoreide-cli      # or: curl -fsSL https://www.nomoreide.com/install.sh | sh
```

## License

AGPL-3.0-only. A commercial license is available — see
[COMMERCIAL.md](https://github.com/Rorogogogo/nomoreide/blob/main/COMMERCIAL.md).
