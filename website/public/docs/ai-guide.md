# NoMoreIDE AI Agent Guide

This guide is written for AI coding agents using NoMoreIDE through MCP.

Last reviewed for NoMoreIDE v0.1.99 in August 2026.

## Setup Prompt

Use this prompt when the user asks you to install or connect NoMoreIDE:

```text
Please set up NoMoreIDE as a local MCP server for this agent. Register a server named nomoreide that runs npx -y nomoreide. After adding it, tell me how to verify it with /mcp, then open the Web UI at http://127.0.0.1:4317/.
```

Preferred setup installs the MCP server and the bundled `nomoreide-debug` skill:

```bash
npx -y nomoreide setup codex
npx -y nomoreide setup claude
npx -y nomoreide setup gemini
```

Start a new agent session after setup. Use the commands below for manual MCP-only setup.

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
Use NoMoreIDE as the shared local workbench for this session. Start by calling nomoreide_list_services and nomoreide_status. Before changing service state, check nomoreide_service_health and recent logs. For Git and GitHub work, inspect status, diffs, PRs, issues, and CI before staging, committing, or merging. For database work, keep MCP queries read-only; return one statement in a standard sql fence, identify the target connection, and direct the human to review it in the locked Web UI SQL console.
```

## Recommended Workflow

1. Call `nomoreide_list_services` to understand registered services, bundles, repositories, databases, and log sources.
2. Call `nomoreide_status` to inspect current runtime state.
3. Call `nomoreide_open_ui` if the human wants the dashboard visible.
4. Use domain-specific tools for the work:
   - Services: health, logs, timeline, start, stop, restart.
   - Git: status, diff, staged diff, log, branch, worktree, snapshot, stage, unstage, commit, push, and clone.
   - GitHub: PRs, issues, comments, commit CI, and workflow runs.
   - Vercel: projects, deployments, production state, and build logs.
   - Database: register/check connections, browse schemas and objects, sample rows, and run read-only SQL.
   - Agent environments: inspect MCPs, skills, and plugins; preview changes and profiles before applying them.
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

Use worktrees when parallel work needs isolation. Create a snapshot before an agent-authored fix when the user needs a reviewable rollback point. Push only after the staged commit and destination credentials have been reviewed.

## Database Inspection Workflow

For database questions:

1. Call `nomoreide_list_databases`.
2. Call `nomoreide_db_schemas` and `nomoreide_db_objects` to navigate the catalog.
3. Call `nomoreide_db_object_details` when definitions, columns, constraints, indexes, or create scripts matter.
4. Call `nomoreide_db_sample` for a specific table.
5. Use `nomoreide_db_query` only for read-only SELECT-style analysis.
6. Treat sampled rows as potentially sensitive user data.
7. Prefer summaries and schema-aware explanations over copying large row sets.

## Database Write Workflow

MCP database tools do not execute writes. If the user asks for an INSERT, UPDATE, DELETE, or DDL statement:

1. Draft exactly one scoped statement.
2. Return it in a standard `sql` fenced block and identify the target connection by name.
3. Direct the human to stage it in NoMoreIDE's locked SQL console.
4. The human unlocks writes, reviews the affected-rows preview, and commits from the Web UI.

Example:

````text
Target connection: `acme-local`

```sql
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

## Vercel Workflow

1. Use `nomoreide_vercel_list_projects` to discover the visible team projects.
2. Use `nomoreide_vercel_list_deployments` and `nomoreide_vercel_get_deployment` to inspect state before drawing conclusions.
3. Use `nomoreide_vercel_deployment_logs` for build failures.
4. Treat Vercel MCP access as read-only. Redeploy, cancel, promote, and rollback are human dashboard actions.

## Agent Environment and Profile Workflow

1. Use `nomoreide_agents_status`, `nomoreide_agents_read_configs`, and `nomoreide_agents_doctor` before changing an agent setup.
2. Keep changes scoped to the requested agent and user or project scope.
3. Preview profile application before applying it and report backup paths after writes.
4. Never place raw credentials in exported or published profiles; NoMoreIDE redacts secret-looking values.

## Safety Rules

- Use NoMoreIDE tools when they match the task.
- Do not assume arbitrary filesystem access.
- Do not kill processes that NoMoreIDE did not start.
- Do not use destructive Git operations.
- Do not expose secrets from service environment or database rows.
- Do not execute database writes through MCP; stage them for human preview.
- Do not mutate Vercel deployments through MCP; direct those actions to the human dashboard.
- Preview agent environment/profile changes and preserve the backups returned by NoMoreIDE.
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
nomoreide_git_push
nomoreide_git_clone
nomoreide_git_register_repository
nomoreide_git_select_repository
nomoreide_git_worktrees
nomoreide_git_create_worktree
nomoreide_git_select_worktree
nomoreide_git_prune_worktrees
```

Snapshot tools:

```text
nomoreide_snapshots_list
nomoreide_snapshot_create
```

Error tools:

```text
nomoreide_list_errors
nomoreide_error_prompt
```

Database tools:

```text
nomoreide_list_databases
nomoreide_register_database
nomoreide_check_database
nomoreide_db_schemas
nomoreide_db_objects
nomoreide_db_object_details
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

Vercel tools:

```text
nomoreide_vercel_list_projects
nomoreide_vercel_list_deployments
nomoreide_vercel_get_deployment
nomoreide_vercel_deployment_logs
```

Documentation and UI tools:

```text
nomoreide_docs
nomoreide_open_ui
nomoreide_close_ui
```

Terminal presentation tools (macOS):

```text
nomoreide_list_terminal_sessions
nomoreide_open_terminal
nomoreide_reclaim_terminal
```

Agent environment tools:

```text
nomoreide_agents_status
nomoreide_agents_read_configs
nomoreide_agents_doctor
nomoreide_agents_add_mcp
nomoreide_agents_remove_mcp
nomoreide_agents_move_mcp_scope
nomoreide_agents_move_skill_scope
nomoreide_agents_snapshot_agent
```

Agent profile and registry tools:

```text
nomoreide_profiles_list
nomoreide_profiles_get
nomoreide_profiles_create
nomoreide_profiles_update
nomoreide_profiles_delete
nomoreide_profiles_snapshot
nomoreide_profiles_apply
nomoreide_profiles_export
nomoreide_profiles_import
nomoreide_profiles_copy_items
nomoreide_profiles_publish
nomoreide_profiles_install_from_registry
nomoreide_profiles_register_github
```
