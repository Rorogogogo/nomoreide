import { describe, expect, test } from "vitest";
import {
  assertPullRequestBranch,
  messageForCommitAction,
  pathsToStageForCommitAction,
} from "../src/web/client/src/features/workflows/use-workflow-runner.js";

describe("workflow commit message selection", () => {
  test("uses the previous agent output for commit actions", () => {
    const message = messageForCommitAction(
      ["", "feat: add workflow gate\n\n- show generated message"],
      2,
      [],
    );

    expect(message).toBe("feat: add workflow gate\n\n- show generated message");
  });

  test("does not stage additional files when the agent already staged changes", () => {
    expect(
      pathsToStageForCommitAction([
        { path: "src/workflow.ts", index: "M", workingTree: " " },
        { path: ".env", index: " ", workingTree: "M" },
      ]),
    ).toEqual([]);
  });

  test("rejects PR workflows on default branches before committing", () => {
    expect(() =>
      assertPullRequestBranch({
        branch: "main",
        ahead: 0,
        behind: 0,
        files: [{ path: "src/workflow.ts", index: " ", workingTree: "M" }],
      }),
    ).toThrow(/Create or switch to a feature branch before opening a PR/);

    expect(() =>
      assertPullRequestBranch({
        branch: "feature/pr-guard",
        ahead: 0,
        behind: 0,
        files: [],
      }),
    ).not.toThrow();
  });
});
