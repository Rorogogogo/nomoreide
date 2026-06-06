# Workflow Commit Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move default commit approval after commit-message generation and show workflow flow on the left with step detail on the right.

**Architecture:** Keep workflow definitions as plain data, but split commit work into an agent draft step, a gate, and a deterministic action. Add a pure helper in the runner to select the generated commit message, then update the run view presentation without changing the workflow execution contract.

**Tech Stack:** TypeScript, React, Vitest, Tailwind CSS, lucide-react.

---

### Task 1: Commit Gate Ordering and Commit Message Selection

**Files:**
- Modify: `src/core/workflows.ts`
- Modify: `src/web/client/src/features/workflows/workflow-composer.ts`
- Modify: `src/web/client/src/features/workflows/use-workflow-runner.ts`
- Test: `test/workflows.test.ts`
- Test: `test/workflow-composer.test.ts`
- Create: `test/workflow-runner-commit-message.test.ts`

- [ ] **Step 1: Write failing tests**

Update `test/workflows.test.ts` so `commit-push` and `ship-it` expect:

```ts
expect(workflow?.steps.slice(0, 3)).toMatchObject([
  { kind: "agent", id: "commit-message", title: "Generate commit message" },
  { kind: "gate", id: "gate-commit", title: "Approve commit" },
  { kind: "action", id: "commit", op: "commit" },
]);
```

Update `test/workflow-composer.test.ts` so custom commit workflows expect commit generation before the commit gate:

```ts
expect(workflow.steps.map((step) => step.kind)).toEqual([
  "gate",
  "agent",
  "agent",
  "gate",
  "action",
  "gate",
  "action",
  "agent",
]);
expect(workflow.steps[2]).toMatchObject({ kind: "agent", id: "commit-message" });
expect(workflow.steps[4]).toMatchObject({ kind: "action", id: "commit", op: "commit" });
```

Create `test/workflow-runner-commit-message.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { messageForCommitAction } from "../src/web/client/src/features/workflows/use-workflow-runner.js";

describe("workflow commit message selection", () => {
  test("uses the previous agent output for commit actions", () => {
    const message = messageForCommitAction(["", "feat: add workflow gate\n\n- show generated message"], 2, []);
    expect(message).toBe("feat: add workflow gate\n\n- show generated message");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/workflows.test.ts test/workflow-composer.test.ts test/workflow-runner-commit-message.test.ts`

Expected: FAIL because the workflow order has not changed and `messageForCommitAction` is not exported.

- [ ] **Step 3: Implement minimal behavior**

In `src/core/workflows.ts`, replace `COMMIT_STEP` with:

```ts
const COMMIT_MESSAGE_STEP: WorkflowStep = {
  kind: "agent",
  id: "commit-message",
  title: "Generate commit message",
  prompt:
    "Stage my changes with `nomoreide_git_stage` (skip anything that looks like a secret, e.g. `.env`), inspect the staged diff once with `nomoreide_git_staged_diff`, then write one conventional-commit message. Do NOT commit. Reply with ONLY the commit message you recommend.",
};

const COMMIT_ACTION_STEP: WorkflowStep = {
  kind: "action",
  id: "commit",
  title: "Commit with approved message",
  op: "commit",
};
```

Use `[COMMIT_MESSAGE_STEP, COMMIT_GATE, COMMIT_ACTION_STEP]` in commit-bearing built-ins.

In `src/web/client/src/features/workflows/workflow-composer.ts`, generate commit workflows with `agentStep("commit-message", ...)`, then `gate("gate-commit", ...)`, then `{ kind: "action", id: "commit", title: "Commit with approved message", op: "commit" }`.

In `src/web/client/src/features/workflows/use-workflow-runner.ts`, export:

```ts
export function messageForCommitAction(outputs: string[], index: number, files: GitFileStatus[]): string {
  const previous = outputs[index - 1]?.trim();
  return previous || generateCommitMessage(files);
}
```

Use it in the `commit` action after staging paths:

```ts
await gitCommit(messageForCommitAction(outputs, currentIndex, status.files));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/workflows.test.ts test/workflow-composer.test.ts test/workflow-runner-commit-message.test.ts`

Expected: PASS.

### Task 2: Two-Pane Run View

**Files:**
- Modify: `src/web/client/src/features/workflows/workflow-panel.tsx`

- [ ] **Step 1: Update run layout**

Refactor `RunView` so it stores a selected step id, renders a left `ol` with all steps, and renders the selected/current step detail on the right. The detail pane reuses `StepBody`, gate buttons, and error text.

- [ ] **Step 2: Keep mobile usable**

Use `lg:grid-cols-[minmax(240px,320px)_minmax(0,1fr)]`; below `lg`, stack the list above the detail.

- [ ] **Step 3: Run targeted checks**

Run: `npx vitest run test/workflows.test.ts test/workflow-composer.test.ts test/workflow-runner-commit-message.test.ts`

Expected: PASS.

Run: `npm run build`

Expected: exit 0.
