# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build        # Vite build (web client) + tsc (server/CLI) → dist/
npm run dev          # Run from source via tsx (no build required)
npm run dev:web      # Vite dev server for web UI at localhost:5173 (proxies /api → localhost:4317)
npm test             # Vitest test suite
npm test -- --run <pattern>  # Run a single test file, e.g. --run config-store
```

The compiled binary entry point is `dist/index.js`, exposed as `nomoreide` when installed globally.

## Architecture

NoMoreIDE is an AI-native service workbench that exposes three UI modes (CLI, TUI, Web dashboard) and an MCP server for AI agent integration. All modes share the same core layer.

### Core Layer (`src/core/`)

Five stateful modules form the backbone:

- **ConfigStore** (`config-store.ts`) — Zod-validated persistent config at `~/.config/nomoreide/config.json`. Stores service definitions (command, cwd, port, env), bundles, and Git repos.
- **ProcessManager** (`process-manager.ts`) — Spawns services, monitors health/URLs from stdout patterns, enforces port availability before start. Only kills processes it spawned — external processes on conflicting ports are reported, not terminated.
- **LogStore** (`log-store.ts`) — In-memory ring buffer (500 lines per service) + file-based append at `.nomoreide/logs/{service}.log`.
- **GitManager** (`git-manager.ts`) — Read-safe Git abstraction; intentionally excludes `reset --hard`, `clean`, `force-push`, `branch -D`. Accepts arbitrary `cwd` so it works with any repo path.
- **ServiceHealth** (`service-health.ts`) + **PortUtils** (`port-utils.ts`) — Health probing and port conflict detection.

### MCP Server (`src/mcp/`)

Built on FastMCP 3.0.0, runs as a stdio MCP server for AI agents (Claude Code, Codex CLI, Gemini CLI). Exposes 30+ tools wrapping core layer operations. Auto-starts the web UI unless `NOMOREIDE_AUTO_UI=0`. All tools are read-safe or scoped to services registered in ConfigStore — no raw filesystem enumeration.

### Web Layer (`src/web/`)

HTTP server on `localhost:4317`. Serves a React SPA + REST API endpoints under `/api/*`. The React frontend (`src/web/client/src/`) uses Vite, React 19, Tailwind CSS 4, Radix UI, and Framer Motion. Two main feature modules: `features/services/` (start/stop/logs/health) and `features/git/` (diff, staging, branching).

### CLI & TUI (`src/cli/`, `src/tui/`)

`src/index.ts` routes to the appropriate mode. CLI subcommands: `mcp`, `tui`, `web`, `add`, `git`, `list`, `logs`, `setup`, `start`, `stop`, `restart`.

### Data Flow

```
AI Agent ──stdio──► MCP Server
                        │
User ───────────► CLI / TUI / Web UI
                        │
                   Core Layer
             (Config / Process / Log / Git)
                        │
                 Managed Processes
```

## Key Patterns

- **Zod everywhere**: all config schemas and MCP tool inputs are validated with Zod at runtime.
- **XDG-compliant**: global config in `~/.config/nomoreide/`, project logs in `.nomoreide/logs/`.
- **TypeScript strict mode**: `tsconfig.json` has `strict: true`; `src/web/client` is excluded from the server tsconfig and built separately by Vite.
- **Test isolation**: tests use `os.tmpdir()` fixtures via Vitest; all test files live in `/test/`.
- **Dual license**: AGPL-3.0 for open source, commercial license for proprietary use (see `COMMERCIAL.md`).
