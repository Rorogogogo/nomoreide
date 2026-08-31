# nomoreide

An AI-native service workbench: one Rust binary exposing a CLI, a TUI, a web
dashboard, and an MCP server for AI agents.

```bash
cargo install nomoreide
```

That installs the `nomoreide` command. Alternatively:

```bash
curl -fsSL https://www.nomoreide.com/install.sh | sh   # precompiled, no Rust needed
npm install -g nomoreide                               # the same binary, via npm
```

`cargo install` compiles from source and takes a few minutes; the other two
download a prebuilt binary.

## What it does

Registers itself with the AI agents you already use — Claude Code, Codex CLI,
Gemini, Cursor and Windsurf — so they can start, stop, inspect and debug your
local services:

```bash
nomoreide setup claude     # or codex, gemini, cursor, windsurf
nomoreide web              # the dashboard, at 127.0.0.1:4317
```

The dashboard is compiled into the binary, so there is nothing to install
beside it.

## This crate

A thin front door. The implementation is
[`nomoreide-cli`](https://crates.io/crates/nomoreide-cli) and the crates below
it; this exists so the name you install matches the command you run.

## License

AGPL-3.0-only. A commercial license is available — see
[COMMERCIAL.md](https://github.com/Rorogogogo/nomoreide/blob/main/COMMERCIAL.md).
