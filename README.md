# NoMoreIDE

NoMoreIDE is an AI-native terminal workbench for the post-IDE development loop. It gives coding agents and humans a shared local control surface for services, ports, logs, Git review, and MCP workflows.

## Status

This is an MVP with a working MCP server, core process manager, terminal UI, React web UI, and safe Git review tools.

## Install

Run without installing:

```bash
npx -y nomoreide
```

Install globally:

```bash
npm install -g nomoreide
```

Or from a local checkout:

```bash
npm install
npm run build
```

## Run

Start the MCP server:

```bash
nomoreide
```

From a local checkout:

```bash
npm run dev
```

Start the terminal UI:

```bash
nomoreide tui
```

Start the local web UI:

```bash
nomoreide web
```

The web UI listens on `http://127.0.0.1:4317` by default. Use another port with:

```bash
nomoreide web --port=4320
```

From a local checkout, prefix CLI commands with `npm run dev --` instead of `nomoreide`.

## Agent CLI MCP Setup

NoMoreIDE runs as a local stdio MCP server. The easiest setup is to let each agent CLI launch the published npm package with `npx`.

### Claude Code

```bash
claude mcp add --transport stdio nomoreide -- npx -y nomoreide
```

Use project scope if you want to commit a shared `.mcp.json` for the current repository:

```bash
claude mcp add --transport stdio --scope project nomoreide -- npx -y nomoreide
```

Inside Claude Code, run `/mcp` to confirm the server is connected.

### Codex CLI

```bash
codex mcp add nomoreide -- npx -y nomoreide
```

Or add it directly to `~/.codex/config.toml`:

```toml
[mcp_servers.nomoreide]
command = "npx"
args = ["-y", "nomoreide"]
```

Inside Codex, run `/mcp` to confirm the server is connected.

### Gemini CLI

Add NoMoreIDE to your Gemini CLI `settings.json`:

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

Restart Gemini CLI, then run `/mcp` to confirm the server is connected.

## CLI

Register a service:

```bash
nomoreide add service backend --command "npm run dev" --cwd /absolute/path/to/backend --port 3001
```

Register a bundle:

```bash
nomoreide add bundle full-stack db backend frontend
```

List registered services and bundles:

```bash
nomoreide list
```

Start, stop, or restart a registered service:

```bash
nomoreide start backend
nomoreide stop backend
nomoreide restart backend
```

Start or stop a bundle:

```bash
nomoreide start full-stack
nomoreide stop full-stack
```

Read recent in-memory logs for the current NoMoreIDE process:

```bash
nomoreide logs backend
```

## Git

NoMoreIDE includes safe Git review commands. It does not expose destructive actions such as hard reset, clean, force push, or branch deletion.

Show status:

```bash
nomoreide git status --cwd /absolute/path/to/repo
```

Register and select Git folders for the web UI:

```bash
nomoreide git add-repo app --path /absolute/path/to/repo
nomoreide git select-repo app
```

Show unstaged diff:

```bash
nomoreide git diff --cwd /absolute/path/to/repo
```

Stage or unstage explicit files:

```bash
nomoreide git stage --cwd /absolute/path/to/repo src/index.ts README.md
nomoreide git unstage --cwd /absolute/path/to/repo src/index.ts
```

Commit staged changes:

```bash
nomoreide git commit --cwd /absolute/path/to/repo --message "feat: add service dashboard"
```

Show recent commits:

```bash
nomoreide git log --cwd /absolute/path/to/repo
```

List branches, fetch remotes, switch branches, or create a branch:

```bash
nomoreide git branch --cwd /absolute/path/to/repo
nomoreide git fetch --cwd /absolute/path/to/repo
nomoreide git switch --cwd /absolute/path/to/repo feature/work
nomoreide git create-branch --cwd /absolute/path/to/repo feature/new-work
```

For a local checkout MCP client setup, point a stdio server entry at the built CLI:

```json
{
  "mcpServers": {
    "nomoreide": {
      "command": "node",
      "args": ["/absolute/path/to/nomoreide/dist/index.js"]
    }
  }
}
```

NoMoreIDE stores service definitions in `nomoreide.config.json` in the directory where the server is launched. Logs are written to `.nomoreide/logs/`.

## MCP Tools

- `nomoreide_list_services`
- `nomoreide_register_service`
- `nomoreide_start_service`
- `nomoreide_stop_service`
- `nomoreide_restart_service`
- `nomoreide_read_logs`
- `nomoreide_register_bundle`
- `nomoreide_start_bundle`
- `nomoreide_stop_bundle`
- `nomoreide_status`
- `nomoreide_git_status`
- `nomoreide_git_branches`
- `nomoreide_git_switch_branch`
- `nomoreide_git_create_branch`
- `nomoreide_git_fetch`
- `nomoreide_git_diff`
- `nomoreide_git_staged_diff`
- `nomoreide_git_log`
- `nomoreide_git_stage`
- `nomoreide_git_unstage`
- `nomoreide_git_commit`
- `nomoreide_git_register_repository`
- `nomoreide_git_select_repository`

## Example Service

Register a service through MCP with:

```json
{
  "name": "backend",
  "command": "npm run dev",
  "cwd": "/absolute/path/to/project/backend",
  "port": 3001,
  "env": {
    "NODE_ENV": "development"
  },
  "description": "API server"
}
```

## Example Bundle

```json
{
  "name": "full-stack",
  "services": ["db", "backend", "frontend"]
}
```

Then call `nomoreide_start_bundle` with:

```json
{
  "name": "full-stack"
}
```

## Safety Model

NoMoreIDE does not scan the whole machine and does not kill unrelated processes. If a registered service port is already occupied, NoMoreIDE reports the conflict instead of terminating the process.

## Development

```bash
npm test
npm run build
```
