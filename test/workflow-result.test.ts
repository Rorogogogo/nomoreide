import { describe, expect, test } from "vitest";
import {
  looksBlocked,
  parseRecommendedBranchName,
  readStepResult,
} from "../apps/dashboard/src/features/workflows/workflow-result.js";

describe("workflow step result", () => {
  test("explicit ok marker → not blocked, marker stripped", () => {
    const result = readStepResult("Opened PR #42: https://github.com/x/y/pull/42\n\nWORKFLOW_STATUS: ok");
    expect(result.blocked).toBe(false);
    expect(result.output).toBe("Opened PR #42: https://github.com/x/y/pull/42");
    expect(result.output).not.toContain("WORKFLOW_STATUS");
  });

  test("explicit blocked marker → blocked, with reason", () => {
    const result = readStepResult("Tried to merge.\n\nWORKFLOW_STATUS: blocked — required checks are failing");
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("required checks are failing");
    expect(result.output).toBe("Tried to merge.");
  });

  test("refusal with no marker is caught by the heuristic", () => {
    // The exact shape from the reported bug — agent refused, no marker.
    const reply =
      "I can't open this PR as requested — there's a conflict. Current branch is `main`, and you've asked to merge into `main`. Want me to create a feature branch?";
    const result = readStepResult(reply);
    expect(result.blocked).toBe(true);
  });

  test("a plain success reply is not blocked", () => {
    expect(looksBlocked("Committed all changes: feat: add workflows.")).toBe(false);
    expect(looksBlocked("Pushed origin/main and opened PR #7.")).toBe(false);
  });

  test("parses a machine-readable branch recommendation", () => {
    expect(
      parseRecommendedBranchName(
        "RATIONALE: This is the branch guard change.\nBRANCH_NAME: feat/workflow-pr-branch-guard",
      ),
    ).toBe("feat/workflow-pr-branch-guard");
  });

  test("parses the branch from a markdown agent recommendation", () => {
    expect(
      parseRecommendedBranchName(
        [
          "## Recommended branch name",
          "",
          "**`feat/workflow-pr-branch-guard`**",
          "",
          "It matches the branch recovery plumbing.",
        ].join("\n"),
      ),
    ).toBe("feat/workflow-pr-branch-guard");
  });
});
