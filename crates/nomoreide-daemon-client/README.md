# nomoreide-daemon-client

The thin HTTP client every NoMoreIDE front door speaks through, plus daemon discovery, adoption and spawn.

Part of [NoMoreIDE](https://github.com/Rorogogogo/nomoreide) — an AI-native
service workbench that exposes one core through a CLI, a TUI, a web dashboard
and an MCP server for AI agents.

One detached, machine-global daemon owns every spawned service. This crate is how the CLI, TUI and MCP server reach it: it reuses a healthy daemon, adopts one it did not start, or spawns one by re-executing the current binary.

## Installing the product

This crate is a component. To install the tool itself:

```bash
cargo install nomoreide          # or: curl -fsSL https://www.nomoreide.com/install.sh | sh
```

## License

AGPL-3.0-only. A commercial license is available — see
[COMMERCIAL.md](https://github.com/Rorogogogo/nomoreide/blob/main/COMMERCIAL.md).
