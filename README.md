# NoMoreIDE

NoMoreIDE is an AI-native terminal workbench for the post-IDE development loop. It gives coding agents and humans a shared local control surface for services, ports, logs, Git review, and MCP workflows.

## Status

This is an MVP with a working MCP server, core process manager, terminal UI, React web UI, and safe Git review tools.

## Install

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
npm run dev -- tui
```

Start the local web UI:

```bash
npm run dev -- web
```

The web UI listens on `http://127.0.0.1:4317` by default. Use another port with:

```bash
npm run dev -- web --port=4320
```

## CLI

Register a service:

```bash
npm run dev -- add service backend --command "npm run dev" --cwd /absolute/path/to/backend --port 3001
```

Register a bundle:

```bash
npm run dev -- add bundle full-stack db backend frontend
```

List registered services and bundles:

```bash
npm run dev -- list
```

Start, stop, or restart a registered service:

```bash
npm run dev -- start backend
npm run dev -- stop backend
npm run dev -- restart backend
```

Start or stop a bundle:

```bash
npm run dev -- start full-stack
npm run dev -- stop full-stack
```

Read recent in-memory logs for the current NoMoreIDE process:

```bash
npm run dev -- logs backend
```

## Git

NoMoreIDE includes safe Git review commands. It does not expose destructive actions such as hard reset, clean, force push, or branch deletion.

Show status:

```bash
npm run dev -- git status --cwd /absolute/path/to/repo
```

Register and select Git folders for the web UI:

```bash
npm run dev -- git add-repo app --path /absolute/path/to/repo
npm run dev -- git select-repo app
```

Show unstaged diff:

```bash
npm run dev -- git diff --cwd /absolute/path/to/repo
```

Stage or unstage explicit files:

```bash
npm run dev -- git stage --cwd /absolute/path/to/repo src/index.ts README.md
npm run dev -- git unstage --cwd /absolute/path/to/repo src/index.ts
```

Commit staged changes:

```bash
npm run dev -- git commit --cwd /absolute/path/to/repo --message "feat: add service dashboard"
```

Show recent commits:

```bash
npm run dev -- git log --cwd /absolute/path/to/repo
```

For an MCP client, point a stdio server entry at the built CLI:

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
