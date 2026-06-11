import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const viewSource = readFileSync(
  "src/web/client/src/features/github/github-view.tsx",
  "utf8",
);
const setupSource = readFileSync(
  "src/web/client/src/features/github/github-token-setup.tsx",
  "utf8",
);
const actionsSource = readFileSync(
  "src/web/client/src/features/github/actions-view.tsx",
  "utf8",
);
const branchesSource = readFileSync(
  "src/web/client/src/features/github/branches-view.tsx",
  "utf8",
);
const prDetailSource = readFileSync(
  "src/web/client/src/features/github/pr-detail.tsx",
  "utf8",
);
const issueListSource = readFileSync(
  "src/web/client/src/features/github/issue-list.tsx",
  "utf8",
);
const issueDetailSource = readFileSync(
  "src/web/client/src/features/github/issue-detail.tsx",
  "utf8",
);

describe("GitHub connection recovery UI", () => {
  test("view renders refresh and reconnect recovery paths", () => {
    expect(viewSource).toContain("GitHubConnectionRecovery");
    expect(viewSource).toContain("Reconnect GitHub");
    expect(viewSource).toContain("Refresh");
    expect(viewSource).toContain("Use token instead");
    expect(viewSource).toContain("auth_error");
    expect(viewSource).toContain("connection_error");
  });

  test("connected view exposes explicit logout", () => {
    expect(viewSource).toContain("removeGitHubToken");
    expect(viewSource).toContain("handleDisconnect");
    expect(viewSource).toContain("Disconnect");
  });

  test("connection chrome avoids badge pills", () => {
    expect(viewSource).not.toContain('components/ui/badge');
    expect(viewSource).toContain("ConnectionState");
    expect(viewSource).toContain("GitHubConnectionIdentity");
  });

  test("GitHub content uses status text and label swatches instead of badge pills", () => {
    expect(actionsSource).toContain("RunConclusionStatus");
    expect(actionsSource).not.toContain("RunConclusionBadge");
    expect(prDetailSource).toContain("StateText");
    expect(prDetailSource).not.toContain("StateBadge");
    expect(issueListSource).toContain("IssueLabelSwatch");
    expect(issueDetailSource).toContain("IssueLabelSwatch");
  });

  test("PR detail presents a review cockpit with files, reviews, checks, and merge readiness", () => {
    expect(prDetailSource).toContain("PRReviewCockpit");
    expect(prDetailSource).toContain("getGitHubPRReviewCockpit");
    expect(prDetailSource).toContain("Changed files");
    expect(prDetailSource).toContain("Review state");
    expect(prDetailSource).toContain("Checks");
    expect(prDetailSource).toContain("Merge readiness");
    expect(prDetailSource).toContain("Open failing check");
  });

  test("connected view uses the same shell and tab rail structure as Git Review", () => {
    expect(viewSource).toContain("bg-card/85");
    expect(viewSource).toContain("bg-card/95");
    expect(viewSource).toContain("tabButtonClass");
    expect(viewSource).toContain("border-b border-border");
    expect(viewSource).toContain('tab === "prs"');
    expect(viewSource).toContain('tab === "issues"');
    expect(viewSource).toContain('tab === "actions"');
  });

  test("GitHub page exposes a compact Branches tab with quick PR creation", () => {
    expect(viewSource).toContain('| "branches"');
    expect(viewSource).toContain("BranchesView");
    expect(viewSource).toContain('setTab("branches")');
    expect(viewSource).toContain("initialHead");
    expect(branchesSource).toContain("listGitHubBranches");
    expect(branchesSource).toContain("Open PR");
    expect(branchesSource).toContain("Default");
    expect(branchesSource).toContain("Current");
    expect(branchesSource).not.toContain("components/ui/badge");
  });

  test("Branches can open Actions filtered to a branch", () => {
    expect(viewSource).toContain("actionsBranch");
    expect(viewSource).toContain("setActionsBranch(head)");
    expect(viewSource).toContain('setTab("actions")');
    expect(viewSource).toContain("onViewRuns");
    expect(viewSource).toContain("branch={actionsBranch ?? undefined}");
    expect(actionsSource).toContain("branch?: string");
    expect(actionsSource).toContain("useGitHubActions(branch)");
    expect(actionsSource).toContain("Filtered to");
    expect(actionsSource).toContain("onClearBranch");
    expect(branchesSource).toContain("View runs");
  });

  test("new PR flow uses a branch-to-PR assistant instead of the manual form", () => {
    expect(viewSource).toContain("BranchToPRAssistant");
    expect(viewSource).toContain("getGitHubPRTemplate");
    expect(viewSource).toContain("Compare summary");
    expect(viewSource).toContain("commits ahead");
    expect(viewSource).toContain("changed files");
    expect(viewSource).toContain("setSelectedNumber(created.number)");
    expect(viewSource).not.toContain("function CreatePRForm");
  });

  test("issue state toggle does not introduce a second right-alignment spacer", () => {
    expect(viewSource).toContain('tab === "issues"');
    expect(viewSource).not.toContain('className="ml-auto flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5"');
  });

  test("setup supports explicit PAT and device-flow starts", () => {
    expect(setupSource).toContain("initialMode");
    expect(setupSource).toContain('"pat"');
    expect(setupSource).toContain('"device-pending"');
  });
});
