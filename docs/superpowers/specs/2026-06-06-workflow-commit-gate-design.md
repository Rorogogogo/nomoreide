# Workflow Commit Gate Design

## Goal

Default commit-bearing workflows generate the commit message before asking for approval. The approval gate shows that generated message, and approving commits directly with that exact message.

## Behavior

- Replace the current default order `Approve commit -> AI commit` with `Generate commit message -> Approve commit -> Commit`.
- The message generation step is an agent step that stages safe files, inspects the staged diff, and replies with only the commit message.
- The approval gate displays the previous step output as the proposed commit message.
- After approval, the deterministic commit action commits already-staged changes with the approved generated message.
- Push and PR gates keep their existing behavior.

## UI

The workflow run view changes to a two-pane layout:

- Left: compact workflow flow list with step status and kind badges.
- Right: selected or active step detail, including task text, generated outputs, gate controls, errors, and blocked messages.

The layout follows the existing restrained product UI and borrows the GitHub Actions pattern of a step list plus focused details.

## Testing

- Built-in workflow tests cover the new default step order.
- Composer tests cover generated custom workflows that include commit.
- Pure helper tests cover selecting a generated commit message for the deterministic commit action.
