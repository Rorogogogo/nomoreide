# Linear tasks

Open **Linear** in the NoMoreIDE sidebar and connect in one of two ways.

**Continue with Linear** signs in through the browser (OAuth 2.0 authorization code with PKCE). Nothing is pasted, the grant is listed in Linear's **Settings → API → Authorized applications**, and it can be revoked there at any time. The button appears only where this build has a Linear OAuth app configured — see [Registering the OAuth app](#registering-the-oauth-app).

**A personal API key** from Linear's **Settings → Security & access** still works and is the fallback where no OAuth app is configured. The key needs permission to read tasks and to create issues, update issues, and create comments for the actions you use.

Either way the credential is stored on the host and never reaches a browser or a phone. The panel shows which of the two is in use, because the two fail differently: a key is revoked by hand and an OAuth grant expires on its own.

Select a NoMoreIDE repository, choose a Linear team and optionally a project, and click **Link to repository**. This mapping is saved on the host. Each repository can have its own mapping. Changing the selection lets you browse another team without overwriting the saved mapping until you click Link.

The page supports task lists, pagination, searching loaded tasks and assignees, status filtering, task creation, descriptions, status changes, and comments. **Work on this task** passes the issue identifier, URL, description, and suggested branch name to the existing agent flow. Branch creation remains part of the agent's work. Include the issue identifier in the PR to use Linear's separately configured GitHub integration.

## Remote web and mobile

The paired machine's owner can manage the same Linear workspace from the device page in the remote web app and native mobile app. Connect the API key on the host first. The key stays in the host's existing connection store and is excluded from public configuration and relay responses. Remote clients do not store or submit Linear credentials.

Use **Prepare agent task**. The prompt drops into the terminal panel above, where you pick an agent and start it — the remote agent surface is the machine's own agent TUI, mirrored, not a separate chat transcript. Approvals appear as the agent's own numbered permission prompt, rendered as tappable buttons.

Scanned guest links have no Linear access. The `linear.tasks` capability gates the new commands so older hosts refuse them explicitly. Reads can run in a degraded protocol session; binding, creation, status changes, and comments are mutations and are refused in degraded sessions. Mutations are never automatically retried. If an operation times out, check Linear before submitting it again.

## Implementation

- Core client: `crates/nomoreide-core/src/linear.rs`. Fixed GraphQL documents with variables, input validation, a timeout, and GraphQL error checking.
- Host routes: `/api/linear/connection` for local connection management and `/api/linear/request` for typed task operations.
- Protocol: `linear.request` / `linear.response`, with a response field allowlist and mutation classification in `crates/nomoreide-remote-protocol/src/linear.rs`.
- Project mapping: `preferences.linearBindings[repositoryName]` in host configuration.
- Dashboard: `apps/dashboard/src/features/linear/`.
- Browser sign-in: `crates/nomoreide-core/src/linear_oauth.rs` (the vendor half) over the shared PKCE flow in `crates/nomoreide-core/src/providers/oauth.rs`, with `/api/linear/oauth/{start,callback,status}` in the host routes.
- Remote API and clients: the sibling `nomoreide-platform` repository. Both host and platform updates must ship for remote support.

Task pages contain 30 issues. Team/project selectors show up to 100 entries, and issue details show up to 50 comments with a link to Linear for the remainder. Search and status filters apply to loaded issues. This version uses manual refresh; webhooks, attachments, and automatic task/PR synchronization are not included.

Reference: [Linear GraphQL API](https://linear.app/developers/graphql).

## Registering the OAuth app

Linear has no dynamic client registration, so the OAuth app is created once by
hand and its client id is compiled in. Until that is done `oauthAvailable` is
false, the dashboard offers only the API-key form, and `/api/linear/oauth/start`
refuses with a sentence saying why.

1. In Linear, go to **Settings → API → OAuth applications** and create one.
2. Set the callback URL to exactly:

   ```
   http://127.0.0.1:4317/api/linear/oauth/callback
   ```

   It must match literally. Linear checks a redirect against the list in this
   form, which is why the daemon's fixed port is used rather than the ephemeral
   loopback port the Vercel sign-in mints per attempt.
3. Turn **Public** on — "Allow this application to be installed by other
   workspaces". Without it only the workspace that created the app can
   authorize it, so every other user's sign-in is refused. Turning it on makes
   **Developer URL** required.

   Leave **Client credentials** and **Webhooks** off. Neither is used: the
   first is a grant type for acting as the app rather than as a person, and
   nothing here subscribes to Linear events.

   **There is no PKCE toggle, and none is needed.** PKCE is negotiated per
   request — sending `code_challenge` on the authorize call is what makes
   `client_secret` optional on the exchange, and that is what this flow does. A
   locally installed binary cannot keep a secret from the person running it, so
   the client secret Linear shows you on creation is deliberately unused: do
   not put it in the repo or the environment.
4. Put the client id in `DEFAULT_CLIENT_ID` in
   `crates/nomoreide-core/src/linear_oauth.rs`, or set
   `NOMOREIDE_LINEAR_CLIENT_ID` for a single install.

The client id is public by design — it identifies the app and authorizes
nothing on its own, the same as the GitHub device-flow id in
`crates/nomoreide-core/src/github_oauth.rs`.

Access tokens last 24 hours. They are renewed on the way into a request rather
than on a timer, and Linear rotates refresh tokens, so what comes back replaces
what went in.
