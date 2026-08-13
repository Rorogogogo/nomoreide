# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build        # Vite build (web client) + tsc (server/CLI) → dist/
npm run dev          # Run from source via tsx (no build required)
npm run dev:web      # Vite dev server for web UI at localhost:5173 (proxies /api → localhost:4317)
npm test             # Vitest test suite
npm test -- config-store      # Run one test file by name fragment
npm run lint         # Biome over src/ (lint:fix to autofix)
npm run tauri:dev    # Tauri desktop app in dev mode (tauri:build to package)
```

The compiled binary entry point is `dist/index.js`, exposed as `nomoreide` when installed globally.

**What CI gates.** `.github/workflows/ci.yml` runs `npm run build` + `npm test` across the Node matrix, and a `quality` job running the web client's type check and Biome. `vite build` does not typecheck, which is why the client check is its own step. To reproduce the `quality` job locally:

```bash
npx tsc -p src/web/client/tsconfig.json --noEmit   # client types (server types are covered by npm run build)
npm run lint
```

Both are currently clean, so any error you see there is yours.

**Merging does not release.** `deploy.yml` is `workflow_dispatch`-only — merges accumulate on `main` (tested there by `ci.yml`) until someone cuts a release with `gh workflow run deploy.yml -f bump=patch`. That job bumps the version, tags `v<version>`, and publishes to npm; the tag push is in turn what triggers `desktop-release.yml` to build the dmg and create the GitHub Release, whose notes come from the body of the PR behind the tag's parent commit (`## Release note` preferred — see `.github/pull_request_template.md`).

## Architecture

NoMoreIDE is an AI-native service workbench that exposes three UI modes (CLI, TUI, Web dashboard) and an MCP server for AI agent integration. All modes share the same core layer.

### Core Layer (`src/core/`)

Five stateful modules form the backbone:

- **ConfigStore** (`config-store.ts`) — Zod-validated persistent config at `~/.config/nomoreide/config.json`. Stores service definitions (command, cwd, port, env), bundles, and Git repos.
- **ProcessManager** (`process-manager.ts`) — Spawns services, monitors health/URLs from stdout patterns, enforces port availability before start. Only kills processes it spawned — external processes on conflicting ports are reported, not terminated.
- **LogStore** (`log-store.ts`) — In-memory ring buffer (500 lines per service) + file-based append at `.nomoreide/logs/{service}.log`.
- **GitManager** (`git-manager.ts`) — Read-safe Git abstraction; intentionally excludes `reset --hard`, `clean`, `force-push`, `branch -D`. Accepts arbitrary `cwd` so it works with any repo path.
- **ServiceHealth** (`service-health.ts`) + **PortUtils** (`port-utils.ts`) — Health probing and port conflict detection.

Around that backbone sit ~45 more feature modules (workflows, error inbox, snapshots, agent environments, GitHub, metrics, terminal sessions). Two of them exist specifically to keep dangerous operations out of the read-safe modules — **respect the split rather than adding writes to the read side**:

| Read-safe (agent-reachable) | Write-capable (guarded) |
| --- | --- |
| `git-manager.ts` | `git-actions.ts` — push/commit/squash-merge |
| `db-peek.ts` | `db-write.ts` — human-only, per-connection unlock, affected-rows preview |
| `vercel-manager.ts` | `vercel-actions.ts` — redeploy/cancel/promote/rollback, dashboard-only (no MCP tools) |

### Shared Daemon (`src/core/daemon-lifecycle.ts`, `src/core/daemon-client.ts`, `src/cli/daemon.ts`)

One detached, machine-global daemon (`nomoreide daemon`, state at `~/.nomoreide/daemon.json`, logs/timeline under `~/.nomoreide/`) owns every spawned service — it *is* the web server on `127.0.0.1:4317`. MCP/CLI/TUI are thin HTTP clients: `ensureDaemon()` reuses (state file + pid + `/api/health` probe), adopts, or spawns it detached; `DaemonClient` wraps the existing REST routes. Services therefore survive session exits and are visible across sessions. `nomoreide daemon {status,stop,restart}` manages it; `stop` (and `POST /api/daemon/shutdown`) stops all services. The Tauri desktop app is the known exception — its Rust core still spawns its own services.

Because the daemon serves the built client from `dist/` on disk, **client-only changes need just `npm run build` + a browser refresh; server changes need `node dist/index.js daemon restart`** (which stops running services).

### MCP Server (`src/mcp/`)

Built on FastMCP 3.0.0, runs as a stdio MCP server for AI agents (Claude Code, Codex CLI, Gemini CLI). Exposes 70+ tools. Service runtime tools (start/stop/logs/status/timeline) call the shared daemon over HTTP; config/git/db/agent tools run locally. Auto-ensures the daemon unless `NOMOREIDE_AUTO_UI=0`. All tools are read-safe or scoped to services registered in ConfigStore — no raw filesystem enumeration.

Tools are grouped by domain in `src/mcp/tools/<domain>.ts`, each exporting a `registerXTools()` and a `X_TOOL_NAMES` list. `tools/index.ts` is a pure aggregator — **adding a tool means editing its domain module (or adding one and registering it), never growing a per-tool branch in the aggregator.** This deliberately mirrors the web route registry below.

### Web Layer (`src/web/`)

HTTP server on `localhost:4317` (the daemon process). Serves a React SPA + REST API endpoints under `/api/*`. The React frontend (`src/web/client/src/`) uses Vite, React 19, Tailwind CSS 4, Radix UI, and Framer Motion, organized as one directory per feature under `features/` (services, git, github, database, errors, workflows, terminal, agent, agent-env, onboard, settings).

`server.ts` is a thin dispatcher: it builds a `RouteServices` context once and matches each request against a **route registry** (`src/web/routes/`). Each domain owns a `<domain>-routes.ts` exporting a `Route[]`; `routes/index.ts` concatenates them in dispatch order (`/api/*` groups first, the SPA-shell catch-alls last). Use `route(method, path, handler)` for exact paths and `patternRoute(regex, paramNames, handler)` for parameterized ones (the handler does its own method check, mirroring 405 behavior). **Adding an endpoint never edits the dispatcher** — add/extend a route module and register it in `routes/index.ts`.

### CLI & TUI (`src/cli/`, `src/tui/`)

`src/index.ts` routes to the appropriate mode. CLI subcommands: `mcp`, `tui`, `web`, `daemon`, `add`, `git`, `list`, `logs`, `setup`, `start`, `stop`, `restart`.

### Data Flow

```
AI Agent ──stdio──► MCP Server ──┐
User ────► CLI / TUI / browser ──┼── HTTP 127.0.0.1:4317 ──► Daemon (web server)
                                 │                            Core Layer
             (config writes go straight to ConfigStore;       (Config / Process / Log / Git)
              the daemon re-reads config from disk per op)         │
                                                              Managed Processes
```

## Key Patterns

- **Zod everywhere**: all config schemas and MCP tool inputs are validated with Zod at runtime.
- **XDG-compliant**: global config in `~/.config/nomoreide/`, project logs in `.nomoreide/logs/`.
- **TypeScript strict mode**: `tsconfig.json` has `strict: true`; `src/web/client` is excluded from the server tsconfig and built separately by Vite.
- **Test isolation**: tests use `os.tmpdir()` fixtures via Vitest; all test files live in `/test/`.
- **i18n (en + zh)**: user-visible strings go through `useT()` (`lib/i18n/`). `en.ts` is the source of truth and defines `TranslationKey`; `zh.ts` is a `Partial` map, so **a key missing from zh silently renders English rather than failing any build** — add both sides in the same change.
- **Dual license**: AGPL-3.0 for open source, commercial license for proprietary use (see `COMMERCIAL.md`).

## Expandability (keep it modular as it grows)

The project is meant to grow feature-by-feature, so new work should land as a **vertical slice**, not edits scattered across god-files:

- A feature = `core/<feature>.ts` (logic) + `web/routes/<feature>-routes.ts` (HTTP) + `mcp/tools/<feature>.ts` (agent surface, where relevant) + `web/client/src/features/<feature>/` (UI). Wire it up at the registry/index, don't grow a central switchboard.
- **Soft size budgets** (a refactor *smell*, not a CI hard-fail): ~300 lines/file, ~50 lines/function. When a file crosses it, split by responsibility — extract React data-fetching into hooks and sub-sections into their own components; group server routes/MCP tools by domain. Large core modules (`process-manager.ts`, `git-manager.ts`) are acceptable but watch their growth.
- Keep generic dispatch/routing **feature-agnostic**; feature specifics live in the feature's own module.
- Respect the existing safety boundaries: `GitManager` stays read-safe (destructive ops belong in a separate, explicitly-guarded module), and app features needing external data (Linear/DB/GitHub) hold **their own** credential/driver — they can't borrow the agent's MCPs.
- **Mirror every new endpoint in the website mock.** The marketing site (`website/`) embeds the *entire* live dashboard (`WorkbenchApp`) and stubs all `/api/*` calls through `website/src/mock-api.ts`. So when a feature adds an endpoint that a view **reads on mount** (anything where the API seam returns `res.<field>`), add a matching handler with demo data to `mock-api.ts` — otherwise the request hits the default `{ ok: true }` fallback, the seam hands the UI `undefined`, and a field/array access during render white-screens the embedded app. Click-action endpoints that only return `{ ok }` don't need one. The mock's fallback `console.warn`s any unhandled `/api/*` path in dev — watch the console when running `npm run dev` in `website/`.
