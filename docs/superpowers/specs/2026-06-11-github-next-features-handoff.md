# GitHub Next Features Handoff

Date: 2026-06-11

## Current GitHub Surface

The GitHub section has been moved out of Git Review into its own top-level GitHub page. It currently supports:

- GitHub connection status checks for the selected repository.
- Refresh, reconnect, manual token setup, and disconnect actions.
- Repository switching from the app header.
- Tabs for Pull Requests, Issues, and Actions.
- Pull request list/detail, diff view, create PR, and squash merge.
- Issue list/detail, comments, and label swatches.
- Workflow runs and job/step status.

The page should stay visually aligned with the Git section: compact tab rail, quiet toolbar, muted background shell, restrained status text, and no pill-heavy badge treatment.

## Recommended Next Feature

Build a **Branch to PR Assistant** first.

This is the best next addition because it connects the local Git workflow to GitHub directly. Instead of making users manually type PR fields, NoMoreIDE can detect the selected repository's current branch, compare it to the default/base branch, summarize the changed commits/files, and prefill a PR draft.

## Goals

- Make PR creation feel native to the Git workflow.
- Reduce manual typing in the existing New PR form.
- Use the selected repository context, not a global GitHub state.
- Keep the UI compact and consistent with the GitHub tab structure.
- Avoid broad GitHub project-management scope creep.

## Proposed UX

Add a new PR creation flow inside the existing Pull Requests tab.

When the user clicks `New PR`, show an assistant panel instead of the plain manual form:

1. Detect current branch from the selected Git repository.
2. Detect the GitHub default branch when possible.
3. Show compare summary:
   - head branch
   - base branch
   - commits ahead
   - changed files
   - CI status for the head SHA if available
4. Prefill:
   - title from branch name or latest commit
   - body from commit list / changed file summary
   - base branch
   - head branch
   - draft checkbox
5. Let the user edit fields before creating the PR.
6. On success, close the assistant, refresh PRs, and select the new PR.

Fallback behavior:

- If current branch cannot be detected, show the same assistant layout with manual branch fields.
- If the repository has no GitHub remote, show the existing connection/recovery-style guidance.
- If compare data fails, keep the form usable and show the error inline.

## Backend/API Shape

Prefer adding a small endpoint rather than making the client assemble everything:

- `GET /api/github/pr-template`
  - Returns selected repo GitHub context, current branch, suggested base branch, suggested title/body, changed files, commit summaries, and any warning.

Optionally add:

- `GET /api/github/compare?base=main&head=my-branch`
  - Useful if the user changes base/head in the form and wants the summary refreshed.

Existing create endpoint can stay:

- `POST /api/github/prs`

## Implementation Notes

- Reuse existing selected-repository resolution and `requireGitHubContext`.
- Prefer Git data already available from the selected repo instead of shelling out redundantly when there are existing helpers.
- Keep GitHub API failures recoverable. The assistant should degrade to a manual form.
- Avoid introducing a large state-management abstraction. A focused hook such as `useGitHubPRTemplate()` is enough.
- Add focused tests around source/API behavior, matching the current test style in `test/github-*-source.test.ts` and `test/web-server.test.ts`.

## Suggested Follow-Up Feature

After Branch to PR Assistant, build a **PR Review Cockpit**:

- Show PR changed files, comments/review state, checks, mergeability, and merge action together.
- Add compact review metadata in the PR detail header.
- Surface failing CI with direct Actions/job links.

This should come second because it benefits from stronger PR creation and branch context first.

## Ready-to-Paste Prompt

Use this in a new conversation:

```text
We are working in /Users/roro/Downloads/work/Personal Project/nomoreide.

Please implement the next GitHub feature: Branch to PR Assistant.

Context:
- GitHub is now a top-level page, not a tab under Git Review.
- The page has Pull Requests, Issues, and Actions tabs.
- It supports selected-repo switching, GitHub connection status, refresh/reconnect/manual token setup, and disconnect.
- Keep the GitHub page visually aligned with the Git section: compact tab rail, quiet toolbar, muted background shell, restrained status text, no pill-heavy badges.
- There are existing GitHub APIs/hooks/components under:
  - src/web/routes/github-routes.ts
  - src/core/github-manager.ts
  - src/web/client/src/lib/api/github.ts
  - src/web/client/src/features/github/
- There are tests:
  - test/web-server.test.ts
  - test/github-token-source.test.ts
  - test/github-navigation-source.test.ts
  - test/github-view-source.test.ts

Goal:
Replace or upgrade the current manual New PR flow with a Branch to PR Assistant.

Expected behavior:
1. When clicking New PR in the Pull Requests tab, show a compact assistant panel.
2. Detect the selected repository's current branch.
3. Detect/suggest the default/base branch where possible.
4. Show a compare summary: base branch, head branch, commits ahead, changed files, and head CI status if available.
5. Prefill PR title/body from branch name, latest commit, commit list, or changed file summary.
6. Let the user edit title/body/base/head/draft before creating the PR.
7. Use the existing POST /api/github/prs creation path if possible.
8. On successful creation, close the assistant, refresh PRs, and select/open the new PR.
9. If branch/compare data cannot be detected, degrade to manual fields with an inline warning instead of blocking PR creation.
10. If the selected repo has no GitHub remote or auth is invalid, reuse the existing GitHub connection recovery behavior.

Suggested backend:
- Add GET /api/github/pr-template that returns selected repo GitHub context, current branch, suggested base, suggested head, suggested title/body, commits, changed files, and warnings.
- Optionally add GET /api/github/compare?base=...&head=... if needed when base/head changes.

Please follow the repo's existing patterns, use test-first where practical, avoid unrelated refactors, and verify with focused tests plus npm run build.
```
