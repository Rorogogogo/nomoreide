import { describe, expect, test } from "vitest";
import type { GitHubWorkflowRun } from "../src/web/client/src/lib/api/github-api.js";
import { actionState } from "../src/web/client/src/features/agent/terminal/dock-status-strip.js";

function workflowRun(
  status: string,
  conclusion: string | null,
): GitHubWorkflowRun {
  return {
    id: 42,
    name: "CI",
    status,
    conclusion,
    html_url: "https://github.com/acme/app/actions/runs/42",
    head_sha: "abc123",
    head_branch: "main",
    created_at: "2026-07-27T00:00:00Z",
    updated_at: "2026-07-27T00:01:00Z",
    run_number: 12,
    event: "push",
  };
}

describe("agent dock GitHub Actions status", () => {
  test.each(["queued", "in_progress", "requested", "waiting"])(
    "treats %s runs as pending",
    (status) => {
      expect(actionState(workflowRun(status, null))).toBe("pending");
    },
  );

  test.each(["success", "neutral", "skipped"])(
    "treats %s conclusions as successful",
    (conclusion) => {
      expect(actionState(workflowRun("completed", conclusion))).toBe("success");
    },
  );

  test.each(["failure", "timed_out", "cancelled"])(
    "treats %s conclusions as failed",
    (conclusion) => {
      expect(actionState(workflowRun("completed", conclusion))).toBe("failure");
    },
  );

  test("keeps unexpected conclusions visibly distinct", () => {
    expect(actionState(workflowRun("completed", "action_required"))).toBe("error");
  });
});
