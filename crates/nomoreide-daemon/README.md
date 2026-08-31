# nomoreide-daemon

The local HTTP server on `127.0.0.1:4317`: route registry, streams, and the embedded web dashboard.

Part of [NoMoreIDE](https://github.com/Rorogogogo/nomoreide) — an AI-native
service workbench that exposes one core through a CLI, a TUI, a web dashboard
and an MCP server for AI agents.

The compiled dashboard is baked into the binary at build time, so an installed daemon serves its UI with no files beside it. A checkout's `dist/web/client` still wins when present, which is what keeps `npm run build` in the development loop.

## Installing the product

This crate is a component. To install the tool itself:

```bash
cargo install nomoreide-cli      # or: curl -fsSL https://www.nomoreide.com/install.sh | sh
```

## License

AGPL-3.0-only. A commercial license is available — see
[COMMERCIAL.md](https://github.com/Rorogogogo/nomoreide/blob/main/COMMERCIAL.md).
