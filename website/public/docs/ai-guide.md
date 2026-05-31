# NoMoreIDE AI Agent Guide

This guide is written for AI coding agents using NoMoreIDE through MCP.

## Setup Prompt

Use this prompt when the user asks you to install or connect NoMoreIDE:

```text
Please set up NoMoreIDE as a local MCP server for this agent. Register a server named nomoreide that runs npx -y nomoreide. After adding it, tell me how to verify it with /mcp.
```

Agent-specific setup commands:

```bash
claude mcp add --transport stdio nomoreide -- npx -y nomoreide
codex mcp add nomoreide -- npx -y nomoreide
```

Gemini MCP configuration:

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

Verify the connection with:

```text
/mcp
```

## Session Operating Prompt

Use this prompt at the beginning of a coding session:

```text
Use NoMoreIDE as the shared local workbench for this session. Start by calling nomoreide_list_services and nomoreide_status. Before changing service state, check nomoreide_service_health and recent logs. For Git work, inspect status and diffs before staging or committing. Prefer NoMoreIDE tools over ad hoc shell commands when a matching tool exists.
```

## Recommended Workflow

1. Call `nomoreide_list_services` to understand registered services, bundles, repositories, databases, and log sources.
2. Call `nomoreide_status` to inspect current runtime state.
3. Call `nomoreide_open_ui` if the human wants the dashboard visible.
4. Use domain-specific tools for the work:
   - Services: health, logs, timeline, start, stop, restart.
   - Git: status, diff, staged diff, log, branch, stage, unstage, commit.
   - Database: list connections, list tables, sample rows.
   - Errors: list incidents, build a debugging prompt.
5. Explain the action before mutating service or Git state.
6. Use focused verification commands and report exact outcomes.

## Service Debugging Workflow

When a service is unhealthy or fails to start:

1. Call `nomoreide_service_health` for the service.
2. Call `nomoreide_read_logs` with a reasonable limit such as 80 to 200 lines.
3. Call `nomoreide_timeline` filtered to the service.
4. Identify whether the issue is command failure, missing dependency, environment variable, port conflict, or application error.
5. If a restart is appropriate, call `nomoreide_restart_service` only after explaining why.
6. Re-check health and logs after the change.

## Git Review Workflow

Before staging or committing:

1. Call `nomoreide_git_status`.
2. Call `nomoreide_git_diff`.
3. Call `nomoreide_git_staged_diff` if there are staged changes.
4. Stage only explicit paths with `nomoreide_git_stage`.
5. Create commits only from reviewed staged changes with `nomoreide_git_commit`.
6. Do not attempt hard reset, clean, force push, or branch deletion through NoMoreIDE.

## Database Inspection Workflow

For database questions:

1. Call `nomoreide_list_databases`.
2. Call `nomoreide_db_tables` for the chosen connection.
3. Call `nomoreide_db_sample` for a specific table.
4. Treat sampled rows as potentially sensitive user data.
5. Prefer summaries and schema-aware explanations over copying large row sets.

## Safety Rules

- Use NoMoreIDE tools when they match the task.
- Do not assume arbitrary filesystem access.
- Do not kill processes that NoMoreIDE did not start.
- Do not use destructive Git operations.
- Do not expose secrets from service environment or database rows.
- Ask before starting, stopping, restarting, staging, or committing when user intent is ambiguous.
- Keep actions scoped to registered services, repositories, databases, and log sources.

## Tool Reference

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

Repository onboarding:

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
