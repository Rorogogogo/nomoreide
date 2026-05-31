# NoMoreIDE Usage Guide

NoMoreIDE is an AI-native local development workbench for services, logs, Git review, database inspection, terminal access, and MCP workflows. It gives humans and AI coding agents one shared control surface for the local development loop.

## Overview

NoMoreIDE runs locally. It can be used as:

- A stdio MCP server for coding agents such as Claude Code, Codex CLI, and Gemini CLI.
- A CLI for registering and controlling services.
- A terminal UI.
- A local React web dashboard.

The core idea is simple: instead of asking an agent to guess what is running, scrape terminal history, or run arbitrary shell commands, NoMoreIDE exposes structured tools for the things agents need most often.

## Quick Start

Run NoMoreIDE directly:

```bash
npx -y nomoreide
```

Install globally if you want the `nomoreide` command on your PATH:

```bash
npm install -g nomoreide
```

Build from source:

```bash
git clone https://github.com/Rorogogogo/nomoreide.git
cd nomoreide
npm install
npm run build
```

## MCP Setup

NoMoreIDE is usually most useful when connected to an AI coding agent as a local stdio MCP server.

Claude Code:

```bash
claude mcp add --transport stdio nomoreide -- npx -y nomoreide
```

Codex CLI:

```bash
codex mcp add nomoreide -- npx -y nomoreide
```

Gemini CLI:

```json
{
  "mcpServers": {
    "nomoreide": {
      "command": "npx",
      "args": ["-y", "nomoreide"]
    }
  }
}
```

Universal setup prompt:

```text
Please set up NoMoreIDE as a local MCP server for this agent. Register a server named nomoreide that runs npx -y nomoreide. After adding it, tell me how to verify it with /mcp.
```

Verify inside the agent:

```text
/mcp
```

## Running Interfaces

Default MCP server:

```bash
nomoreide
```

Terminal UI:

```bash
nomoreide tui
```

Web dashboard:

```bash
nomoreide web
```

The dashboard defaults to:

```text
http://127.0.0.1:4317
```

Use a custom web port:

```bash
nomoreide web --port=4320
```

## CLI Reference

Print MCP setup guidance:

```bash
nomoreide setup
```

Register a local service:

```bash
nomoreide add service backend \
  --command "npm run dev" \
  --cwd /absolute/path/to/backend \
  --port 3001
```

Register a Docker Compose service:

```bash
nomoreide add service api \
  --kind docker-compose \
  --cwd /absolute/path/to/infra \
  --compose-file docker-compose.yml \
  --compose-service api \
  --port 3001
```

Register an SSH service:

```bash
nomoreide add service staging-api \
  --kind ssh \
  --host devbox \
  --cwd /srv/app \
  --command "npm run dev" \
  --port 3001
```

Register a bundle:

```bash
nomoreide add bundle full-stack db backend frontend
```

List registered services and bundles:

```bash
nomoreide list
```

Control services and bundles:

```bash
nomoreide start backend
nomoreide stop backend
nomoreide restart backend
nomoreide start full-stack
nomoreide stop full-stack
```

Read recent logs:

```bash
nomoreide logs backend
```

Git commands:

```bash
nomoreide git status --cwd /path/to/repo
nomoreide git diff --cwd /path/to/repo
nomoreide git stage --cwd /path/to/repo src/index.ts README.md
nomoreide git unstage --cwd /path/to/repo src/index.ts
nomoreide git commit --cwd /path/to/repo --message "feat: add dashboard"
nomoreide git log --cwd /path/to/repo
nomoreide git branch --cwd /path/to/repo
nomoreide git fetch --cwd /path/to/repo
nomoreide git switch --cwd /path/to/repo feature/my-work
nomoreide git create-branch --cwd /path/to/repo feature/new-work
nomoreide git add-repo app --path /path/to/repo
nomoreide git select-repo app
```

## Web Dashboard Guide

The dashboard is the human-facing local control panel.

Services:

- Register local, Docker Compose, or SSH-backed services.
- Start, stop, and restart services.
- See process state, ports, URLs, and health.
- Use bundles to start several services together.

Logs:

- Read recent service logs.
- Inspect stdout and stderr in the context of service state.
- Use service context packets to hand useful debugging context to an agent.

Git Review:

- Select a registered repository.
- Inspect status, diffs, staged diffs, branches, and history.
- Stage and unstage explicit files.
- Commit staged changes.

Error Inbox:

- Review deduplicated stack traces and error incidents found in managed service logs.
- Generate an agent debugging prompt for an incident.

Database:

- Register Postgres, MySQL, or SQLite connections.
- List tables and views.
- Sample rows and schema metadata for inspection.
- Use read-only browsing by default.

Terminal:

- Work in an embedded terminal surface when available.
- Keep terminal work close to the dashboard context.

Agent dock:

- Use the AI-native entry points in the UI to hand structured context to the agent.
- Keep agent actions visible to the human user.

## MCP Tool Reference

Service tools:

```text
nomoreide_list_services
nomoreide_register_service
nomoreide_start_service
nomoreide_stop_service
nomoreide_restart_service
nomoreide_read_logs
nomoreide_register_bundle
nomoreide_start_bundle
nomoreide_stop_bundle
nomoreide_status
nomoreide_service_context
nomoreide_service_health
nomoreide_timeline
```

Repo onboarding:

```text
nomoreide_onboard_repo
```

Git tools:

```text
nomoreide_git_status
nomoreide_git_branches
nomoreide_git_switch_branch
nomoreide_git_create_branch
nomoreide_git_fetch
nomoreide_git_diff
nomoreide_git_staged_diff
nomoreide_git_log
nomoreide_git_stage
nomoreide_git_unstage
nomoreide_git_commit
nomoreide_git_register_repository
nomoreide_git_select_repository
```

Error tools:

```text
nomoreide_list_errors
nomoreide_error_prompt
```

Database tools:

```text
nomoreide_list_databases
nomoreide_db_tables
nomoreide_db_sample
```

Agent and UI tools:

```text
nomoreide_open_ui
nomoreide_close_ui
```

## Configuration Model

NoMoreIDE stores global configuration at:

```text
~/.config/nomoreide/config.json
```

The config contains:

- `services`: local, Docker Compose, or SSH service definitions.
- `bundles`: ordered groups of service names.
- `gitRepositories`: named repository paths for the dashboard and MCP tools.
- `selectedGitRepository`: the active repository shown by the UI.
- `databases`: registered Postgres, MySQL, or SQLite connections.
- `logSources`: named log readers for files, SSH paths, commands, journald, or Docker logs.

Service definition example:

```json
{
  "name": "backend",
  "kind": "local",
  "command": "npm run dev",
  "cwd": "/absolute/path/to/backend",
  "port": 3001,
  "description": "REST API server"
}
```

Bundle definition example:

```json
{
  "name": "full-stack",
  "services": ["db", "backend", "frontend"]
}
```

## Safety Model

NoMoreIDE is designed to be safe for AI-assisted development:

- It does not scan or enumerate the whole filesystem.
- It works from registered services, repositories, databases, and log sources.
- It does not kill external processes that it did not start.
- It reports port conflicts instead of terminating the occupying process.
- Git tools omit hard reset, clean, force push, and branch deletion.
- Git staging requires explicit file paths.
- Database MCP tools are read-only browsing and sampling tools.
- SSH services rely on the user's local SSH config and agent; NoMoreIDE does not store key material.
- Logs are scoped to `.nomoreide/logs/` for managed services.

## Troubleshooting

MCP server does not show up:

- Re-run the setup command for your agent.
- Restart the agent if its MCP configuration is loaded at startup.
- Verify with `/mcp`.
- Check that `npx -y nomoreide` works in your shell.

Node or npx problems:

- Use Node.js 20 or newer.
- Run `node --version`.
- Try `npm install -g nomoreide` if `npx` is blocked.

Dashboard port conflict:

- Default dashboard port is `4317`.
- Start with `nomoreide web --port=4320`.
- Check the occupying process before stopping anything.

Service will not start:

- Confirm the service `cwd` is absolute and exists.
- Confirm the command works manually.
- Check `nomoreide_service_health`.
- Read logs with `nomoreide_read_logs`.
- Inspect `nomoreide_timeline`.

Logs are empty:

- Confirm the service was started by NoMoreIDE in this runtime.
- Confirm the process writes to stdout or stderr.
- Check `.nomoreide/logs/`.

Git repository is not registered:

- Register it with `nomoreide_git_register_repository` or `nomoreide git add-repo`.
- Use an absolute path.
- Confirm the path is a Git worktree.

Database connection fails:

- Confirm the connection URL is correct.
- Confirm the database is reachable from the local machine.
- Use least-privilege read-only credentials when possible.

## Architecture

Core layer:

- `ConfigStore` owns persisted configuration.
- `ProcessManager` starts and monitors registered services.
- `LogStore` keeps recent logs in memory and writes service logs to disk.
- `GitManager` wraps safe Git operations.
- `ServiceHealth`, `TimelineStore`, `DbPeek`, and `ErrorInbox` add diagnostics and inspection.

MCP server:

- Built with FastMCP.
- Runs over stdio.
- Registers domain-specific tool groups from `src/mcp/tools/`.
- Auto-starts the web UI unless `NOMOREIDE_AUTO_UI=0`.

Web server:

- Serves the local dashboard at `127.0.0.1:4317` by default.
- Uses a route registry under `src/web/routes/`.
- Keeps the dispatcher feature-agnostic.

React dashboard:

- Built with Vite, React, Tailwind CSS, Radix UI primitives, lucide-react, and related UI dependencies.
- Feature modules live under `src/web/client/src/features/`.

CLI and TUI:

- `src/index.ts` dispatches to MCP, TUI, web, service, and Git commands.
- CLI subcommands share the same core layer as MCP and web.

Data flow:

```text
AI agent -> MCP stdio -> NoMoreIDE tools -> core managers -> managed services, logs, Git, database metadata
Human -> CLI/TUI/Web dashboard -> same core managers
```

## Development

Install dependencies:

```bash
npm install
```

Run from source:

```bash
npm run dev
```

Run the web client dev server:

```bash
npm run dev:web
```

Run tests:

```bash
npm test
```

Build package output:

```bash
npm run build
```

Build the landing website:

```bash
npm --prefix website run build
```

## Licensing

NoMoreIDE is AGPL-3.0 licensed with a commercial license available for closed-source, proprietary, hosted, or internal company use cases where AGPL obligations do not fit.

See:

- `LICENSE`
- `COMMERCIAL.md`
