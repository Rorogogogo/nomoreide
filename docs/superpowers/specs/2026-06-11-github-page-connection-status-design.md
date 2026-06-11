# GitHub Page and Connection Status Design

## Goal

Make GitHub feel like a first-class product area instead of a nested Git tab, and make connection failures recoverable without forcing the user to guess whether they should refresh, reauthenticate, or replace a token.

## Current State

GitHub lives under the Git Review page as a tab. The section already contains pull requests, issues, GitHub Actions, device-flow login, PAT fallback, PR creation, PR merge, and issue comments. The auth check only reports whether a token is configured and whether device flow is available. A revoked, expired, or under-scoped token still appears configured until a PR, issue, or Actions request fails inside the nested view.

## Recommended Approach

Promote GitHub to its own top-level sidebar page and remove it from the Git Review tab list. Keep the local Git page focused on repository state: changed files, all files, graph, largest files, snapshots, and workflows.

The GitHub page owns authentication state and recovery. It shows a compact connection banner or status chip near the page header and provides explicit actions:

- Refresh: retry connection validation and reload visible GitHub data.
- Reconnect: start the GitHub device flow again when available.
- Use token instead: open the existing Personal Access Token form.

This is better than keeping GitHub nested because GitHub already has multiple sub-areas and independent auth state. A top-level page also gives failures room to explain themselves without crowding the local Git review UI.

## Status Model

The client should distinguish these states:

- `checking`: status validation is in progress.
- `not_configured`: no GitHub token exists.
- `connected`: a token exists and a lightweight GitHub API request succeeds.
- `auth_error`: GitHub rejected the token, usually `401` or `403`.
- `connection_error`: validation could not complete because of network, rate-limit, selected repository, or GitHub API errors.

The existing `/api/github/token` response should be extended so the frontend can render these states without waiting for PR/issue/action requests to fail. The validation request should be lightweight. If a selected GitHub repository exists, validate access to that repository. If repository context is unavailable, validate against the authenticated user endpoint.

## UI Behavior

The top-level app adds a `GitHub` sidebar item and `/github` route. `GitHubView` moves from the Git tab into that route. The Git Review page removes its GitHub tab button and import.

When status is `not_configured`, the page shows the existing connect screen.

When status is `connected`, the page shows the current PRs, Issues, and Actions sub-tabs. The page header includes a connected status chip and a refresh button.

When status is `auth_error`, the page shows a recovery panel with the exact error, `Reconnect GitHub`, and `Use token instead`. The user can re-run login without manually deleting the old token first.

When status is `connection_error`, the page keeps the recovery panel non-destructive: `Refresh` is primary, and `Reconnect GitHub` is secondary. This avoids forcing relogin when GitHub or the network may simply be unavailable.

Inline list errors can remain, but auth-like errors from PRs, issues, Actions, comments, diffs, or merge/create calls should feed the page-level status so the user gets the same recovery actions everywhere.

## Data Flow

1. `GitHubView` calls `useGitHubToken`.
2. `useGitHubToken` loads status from the server and returns status, error, configured, device-flow availability, and refresh/reconnect helpers.
3. `GitHubView` renders setup, recovery, or connected content based on status.
4. Successful device-flow or PAT login refreshes status and returns the user to connected content.
5. GitHub data hooks keep their existing fetch responsibilities, but surfaced auth failures should trigger a token status refresh or callback so the page-level fallback appears.

## Error Handling

Use precise copy and concrete actions:

- No token: ask the user to connect GitHub.
- Unauthorized or forbidden: ask the user to reconnect or replace the token.
- Network/rate-limit/API failures: offer refresh first, then relogin as a fallback.
- Missing GitHub remote or unsupported remote URL: explain that the selected repository must have a GitHub `origin`.

Do not delete tokens automatically. Reconnect overwrites the saved `github.com` token only after the new flow succeeds.

## Testing

Unit and component tests should cover:

- App routing and sidebar navigation for `/github`.
- Git Review no longer renders the GitHub tab.
- `useGitHubToken` maps server status to UI states.
- GitHub recovery panel renders refresh, reconnect, and PAT fallback actions for failure states.
- Server token status reports configured, not configured, auth failure, and connection failure cases.

Existing GitHub PR, issue, Actions, OAuth, and token tests should remain in place.
