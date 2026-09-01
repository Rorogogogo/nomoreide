# Changelog

Notable changes per release. Versions are shared across every channel —
`install.sh`, npm, the macOS dmg, and crates.io.

## Unreleased

### Five agents instead of three

`nomoreide setup` now covers **Cursor** and **Windsurf** alongside Claude Code,
Codex and Gemini. `install.sh --setup auto` detects and configures whichever of
the five are present, so one command still sets up everything on the machine.

- Cursor reads `~/.cursor/mcp.json`; Windsurf reads
  `~/.codeium/windsurf/mcp_config.json` and its documented `serverUrl` field for
  remote servers.
- Fixed: `setup windsurf` installed no skill when Codex had been set up first.
  Windsurf's candidate list included Codex's portable `~/.agents/skills`, so it
  found that copy, reported "skill identical", and wrote nothing where Windsurf
  actually looks. `--setup auto` runs codex before windsurf, so this was the
  default path rather than a corner case.

### The dashboard ships inside the binary

The compiled dashboard is compiled into the executable rather than read from
disk beside it. An installed daemon needs no files next to it, and the archive
layout is no longer what makes the UI work — a whole class of "unpacked one
level off, every page 500s" bugs is gone.

A checkout still prefers `dist/web/client`, so `npm run build` takes effect
without recompiling Rust.

### Installable from crates.io

```bash
cargo install nomoreide
```

Seven crates publish together. `nomoreide` is the front door — the name matching
the command, `install.sh` and `npm install -g nomoreide` — over `nomoreide-cli`
and the five crates beneath it. Publishing runs from the release tag with no
token, using crates.io trusted publishing.

## 0.3.0

First release with precompiled CLI archives for macOS (arm64, x86_64) and Linux
(x86_64, arm64), published alongside the macOS dmg, with a single `SHA256SUMS`
and Sigstore build provenance.

- The Linux archives are glibc, tested by running the built binary in Debian 12,
  Ubuntu 22.04 and Rocky 9 containers rather than asserting a version number.
- `reqwest` moved to rustls, so nothing links OpenSSL. The previous build needed
  `libssl.so.3` at runtime and did not start at all on a bare `debian:12`.
- npm ships the same Rust binary: `nomoreide` is a shim over four
  platform packages, and npm can never name a version whose binaries are missing.
