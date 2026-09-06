# Linear tasks

Open **Linear** in the NoMoreIDE sidebar and connect a personal API key from Linear's **Settings → Security & access**. The key needs permission to read tasks and to create issues, update issues, and create comments for the actions you use. No OAuth app registration is required for this version.

Select a NoMoreIDE repository, choose a Linear team and optionally a project, and click **Link to repository**. This mapping is saved on the host. Each repository can have its own mapping. Changing the selection lets you browse another team without overwriting the saved mapping until you click Link.

The page supports task lists, pagination, searching loaded tasks and assignees, status filtering, task creation, descriptions, status changes, and comments. **Work on this task** passes the issue identifier, URL, description, and suggested branch name to the existing agent flow. Branch creation remains part of the agent's work. Include the issue identifier in the PR to use Linear's separately configured GitHub integration.

## Remote web and mobile

The paired machine's owner can manage the same Linear workspace from the device page in the remote web app and native mobile app. Connect the API key on the host first. The key stays in the host's existing connection store and is excluded from public configuration and relay responses. Remote clients do not store or submit Linear credentials.

Use **Prepare agent task**, then review and start the task in the Agent panel above. Execution and approvals use the existing remote agent workflow.

Scanned guest links have no Linear access. The `linear.tasks` capability gates the new commands so older hosts refuse them explicitly. Reads can run in a degraded protocol session; binding, creation, status changes, and comments are mutations and are refused in degraded sessions. Mutations are never automatically retried. If an operation times out, check Linear before submitting it again.

## Implementation

- Core client: `crates/nomoreide-core/src/linear.rs`. Fixed GraphQL documents with variables, input validation, a timeout, and GraphQL error checking.
- Host routes: `/api/linear/connection` for local connection management and `/api/linear/request` for typed task operations.
- Protocol: `linear.request` / `linear.response`, with a response field allowlist and mutation classification in `crates/nomoreide-remote-protocol/src/linear.rs`.
- Project mapping: `preferences.linearBindings[repositoryName]` in host configuration.
- Dashboard: `apps/dashboard/src/features/linear/`.
- Remote API and clients: the sibling `nomoreide-platform` repository. Both host and platform updates must ship for remote support.

Task pages contain 30 issues. Team/project selectors show up to 100 entries, and issue details show up to 50 comments with a link to Linear for the remainder. Search and status filters apply to loaded issues. This version uses manual refresh and API-key authentication; OAuth, webhooks, attachments, and automatic task/PR synchronization are not included.

Reference: [Linear GraphQL API](https://linear.app/developers/graphql).
