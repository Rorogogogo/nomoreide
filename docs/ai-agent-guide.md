# NoMoreIDE AI Agent Guide

This guide is written for AI coding agents using NoMoreIDE through MCP.

## Setup Prompt

Use this prompt when the user asks you to install or connect NoMoreIDE:

```text
Please set up NoMoreIDE as a local MCP server for this agent. Register a server named nomoreide that runs npx -y nomoreide. After adding it, tell me how to verify it with /mcp, then open the Web UI at http://127.0.0.1:4317/.
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
Use NoMoreIDE as the shared local workbench for this session. Start by calling nomoreide_list_services and nomoreide_status. Before changing service state, check nomoreide_service_health and recent logs. For Git and GitHub work, inspect status, diffs, PRs, issues, and CI before staging, committing, or merging. For database work, keep MCP queries read-only; stage writes with a sql-write block so the human can review them in the Web UI SQL console.
```

## Recommended Workflow

1. Call `nomoreide_list_services` to understand registered services, bundles, repositories, databases, and log sources.
2. Call `nomoreide_status` to inspect current runtime state.
3. Call `nomoreide_open_ui` if the human wants the dashboard visible.
4. Use domain-specific tools for the work:
   - Services: health, logs, timeline, start, stop, restart.
   - Git: status, diff, staged diff, log, branch, stage, unstage, commit.
   - GitHub: PRs, issues, comments, commit CI, and workflow runs.
   - Database: list connections, list tables, sample rows, read-only SQL query.
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
4. Use `nomoreide_db_query` only for read-only SELECT-style analysis.
5. Treat sampled rows as potentially sensitive user data.
6. Prefer summaries and schema-aware explanations over copying large row sets.

## Database Write Workflow

MCP database tools do not execute writes. If the user asks for an INSERT, UPDATE, DELETE, or DDL statement:

1. Draft exactly one scoped statement.
2. Return it in a fenced block tagged `sql-write` followed by the connection name.
3. Do not tell the user to manually copy it into a console.
4. Let NoMoreIDE render the "Open in SQL console" action.
5. The human unlocks writes, reviews the affected-rows preview, and commits from the Web UI.

Example:

````text
```sql-write acme-local
UPDATE users SET role = 'developer' WHERE id = 'usr_01hx8q9n';
```
````

## GitHub Workflow

When GitHub is connected:

1. Use `nomoreide_github_list_prs` and `nomoreide_github_get_pr` to inspect PR state.
2. Use `nomoreide_github_get_commit_ci` and `nomoreide_github_list_workflow_runs` before merge decisions.
3. Use issue/comment tools for repo context rather than scraping GitHub pages.
4. Create or merge PRs only when the user clearly asks.
5. Report exact PR, issue, CI, or Actions URLs returned by the tools.

## Safety Rules

- Use NoMoreIDE tools when they match the task.
- Do not assume arbitrary filesystem access.
- Do not kill processes that NoMoreIDE did not start.
- Do not use destructive Git operations.
- Do not expose secrets from service environment or database rows.
- Do not execute database writes through MCP; stage them for human preview.
- Ask before starting, stopping, restarting, staging, committing, creating PRs/issues, commenting, or merging when user intent is ambiguous.
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
nomoreide_db_query
```

GitHub tools:

```text
nomoreide_github_set_token
nomoreide_github_list_prs
nomoreide_github_get_pr
nomoreide_github_get_pr_diff
nomoreide_github_create_pr
nomoreide_github_merge_pr
nomoreide_github_list_issues
nomoreide_github_get_issue
nomoreide_github_list_issue_comments
nomoreide_github_add_issue_comment
nomoreide_github_create_issue
nomoreide_github_get_commit_ci
nomoreide_github_list_workflow_runs
```

Agent and UI tools:

```text
nomoreide_open_ui
nomoreide_close_ui
```
