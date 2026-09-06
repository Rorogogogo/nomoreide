import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { catalogSource } from "./support/i18n-source";

// The GitHub page's rendering now spans three files — the tabs and data in
// github-view.tsx, the failure paths in github-connection-recovery.tsx, and the
// new-PR prompt in branch-to-pr-assistant.tsx. These assertions are about what
// the *page* renders, so they read all three.
const viewSource = [
  "github-view.tsx",
  "github-connection-recovery.tsx",
  "branch-to-pr-assistant.tsx",
]
  .map((file) => readFileSync(`apps/dashboard/src/features/github/${file}`, "utf8"))
  .join("\n");
const setupSource = readFileSync(
  "apps/dashboard/src/features/github/github-token-setup.tsx",
  "utf8",
);
const accountSelectorSource = readFileSync(
  "apps/dashboard/src/features/github/github-account-selector.tsx",
  "utf8",
);
const accountMenuSource = readFileSync(
  "apps/dashboard/src/features/github/github-account-menu.tsx",
  "utf8",
);
const accountMenuHookSource = readFileSync(
  "apps/dashboard/src/features/github/hooks/use-github-account-menu.ts",
  "utf8",
);
const actionsSource = readFileSync(
  "apps/dashboard/src/features/github/actions-view.tsx",
  "utf8",
);
const branchesSource = readFileSync(
  "apps/dashboard/src/features/github/branches-view.tsx",
  "utf8",
);
const prDetailSource = readFileSync(
  "apps/dashboard/src/features/github/pr-detail.tsx",
  "utf8",
);
const tabsSource = readFileSync(
  // Shared with the Vercel view, so it lives in components/ui rather than
  // inside the GitHub feature.
  "apps/dashboard/src/components/ui/tab-strip.tsx",
  "utf8",
);
const prListSource = readFileSync(
  "apps/dashboard/src/features/github/pr-list.tsx",
  "utf8",
);
const issueListSource = readFileSync(
  "apps/dashboard/src/features/github/issue-list.tsx",
  "utf8",
);
const issueDetailSource = readFileSync(
  "apps/dashboard/src/features/github/issue-detail.tsx",
  "utf8",
);
// UI copy now lives in the i18n catalog (t("...")), so text the views render is
// asserted against en.ts rather than the component source.
const catalog = catalogSource("en");

describe("GitHub connection recovery UI", () => {
  test("announces account selection failures accessibly", () => {
    expect(accountSelectorSource).toContain('role="alert"');
    expect(accountSelectorSource).toContain('aria-live="assertive"');
    expect(accountSelectorSource).toContain("aria-describedby");
  });
  test("view renders refresh and reconnect recovery paths", () => {
    expect(viewSource).toContain("GitHubConnectionRecovery");
    expect(catalog).toContain("Reconnect GitHub");
    expect(catalog).toContain("Refresh");
    expect(catalog).toContain("Use token instead");
    expect(viewSource).toContain("auth_error");
    expect(viewSource).toContain("connection_error");
    expect(viewSource).toContain("github.technicalDetails");
    expect(viewSource).toContain("<details");
    expect(viewSource).toContain('className="h-7 px-2 text-[11px]"');
  });

  test("connection recovery uses the flat workbench empty-state treatment", () => {
    expect(viewSource).toContain('aria-labelledby="github-connection-title"');
    expect(viewSource).not.toContain(
      'w-full max-w-lg space-y-4 rounded-md border border-border bg-card p-5',
    );
  });

  test("run status marks distinguish running, skipped and failed", () => {
    // A run that is executing gets the rotating ring; queued keeps the static
    // dot, because nothing is running yet and a spinner would say otherwise.
    expect(actionsSource).toContain("RunningRing");
    expect(actionsSource).toMatch(/status === "in_progress"[\s\S]{0,120}RunningRing/);
    expect(actionsSource).toMatch(/status === "queued"[\s\S]{0,120}DotCircleFill/);
    // Skipped used to render a green check and cancelled a red X: one claimed a
    // step passed when it never ran, the other made an aborted run look broken.
    expect(actionsSource).toMatch(/"skipped" \|\| \w+\.conclusion === "cancelled"[\s\S]{0,120}SkipCircle/);
    expect(actionsSource).not.toMatch(/"success" \|\| \w+\.conclusion === "skipped"/);
    expect(actionsSource).not.toMatch(/"cancelled"[\s\S]{0,80}XCircleFill/);
  });

  test("the account menu exposes an explicit logout for tokens we own", () => {
    // Removing a stored token is the only sign-out NoMoreIDE can perform — a
    // `gh` credential belongs to the CLI. It lives in the account menu (opened
    // from the header) rather than the GitHub page, so it is reachable from
    // anywhere instead of only after navigating to that one view.
    expect(accountMenuHookSource).toContain("removeGitHubToken");
    expect(accountMenuHookSource).toContain("async function disconnect");
    expect(accountMenuSource).toContain("controller.disconnect()");
    expect(catalog).toContain("Remove stored token");
    // …and a `gh` account gets no sign-out row and no explainer for the one it
    // lacks: adding an account, the thing sign-out was being used for, has its
    // own section now.
    expect(accountMenuSource).not.toContain("gh auth logout");
  });

  test("connection chrome avoids badge pills", () => {
    expect(viewSource).not.toContain('components/ui/badge');
    expect(viewSource).toContain("ConnectionState");
  });

  test("does not repeat the header's connection identity in the page toolbar", () => {
    // The app header already shows a GitHub status dot + repo name; a second
    // logo/dot/repo row directly under it was pure duplication.
    expect(viewSource).not.toContain("GitHubConnectionIdentity");
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
    expect(catalog).toContain("Changed files");
    expect(catalog).toContain("Review state");
    expect(catalog).toContain("Checks");
    expect(catalog).toContain("Merge readiness");
    expect(catalog).toContain("Open failing check");
  });

  test("connected view uses the workbench page shell, not a tinted card layer", () => {
    // The page canvas is `bg-background` like Docker and Activity; the tinted
    // `bg-card/85` shell it used to carry was a decorative layer over the same
    // content. Only the toolbar keeps a card tint, to separate it from the list.
    expect(viewSource).toContain("overflow-hidden bg-background");
    expect(viewSource).not.toContain("bg-card/85");
    expect(viewSource).toContain("bg-card/75");
    expect(viewSource).toContain("border-b border-border");
    expect(viewSource).toContain('tab === "prs"');
    expect(viewSource).toContain('tab === "issues"');
    // Actions is the fall-through branch of the panel switch, so assert the
    // tab itself rather than a comparison the source never had to write.
    expect(viewSource).toContain('id: "actions"');
    expect(viewSource).toContain("<ActionsView");
  });

  test("page tabs carry real tab semantics instead of bare buttons", () => {
    // The four tabs were hand-written <button>s with no tablist, no
    // aria-selected, and no focus ring — keyboard and screen-reader users got
    // an unlabelled row of buttons. TabStrip owns those semantics for every
    // GitHub tab strip, including PR detail's Review/Diff pair.
    expect(tabsSource).toContain('role="tablist"');
    expect(tabsSource).toContain('role="tab"');
    expect(tabsSource).toContain("aria-selected");
    expect(tabsSource).toContain("aria-controls");
    expect(tabsSource).toContain("focus-visible:ring-ring");
    expect(viewSource).toContain("<TabStrip");
    expect(viewSource).toContain('role="tabpanel"');
    expect(prDetailSource).toContain("<TabStrip");
    expect(prDetailSource).toContain('role="tabpanel"');
    expect(viewSource).not.toContain("tabButtonClass");
    expect(prDetailSource).not.toContain("const tabClass");
  });

  test("GitHub page exposes a compact Branches tab with quick PR creation", () => {
    expect(viewSource).toContain('id: "branches"');
    expect(viewSource).toContain("BranchesView");
    expect(viewSource).toContain("initialHead");
    expect(branchesSource).toContain("listGitHubBranches");
    expect(catalog).toContain("Open PR");
    expect(catalog).toContain("Default");
    expect(catalog).toContain("Current");
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
    expect(catalog).toContain("Filtered to");
    // Clearing the filter lives on the tab row now, next to the chip naming
    // the branch — the page already owns `actionsBranch`, so ActionsView never
    // needed a callback to hand it back.
    expect(viewSource).toContain("setActionsBranch(null)");
    expect(catalog).toContain("View runs");
  });

  test("new PR flow uses a branch-to-PR assistant instead of the manual form", () => {
    expect(viewSource).toContain("BranchToPRAssistant");
    expect(viewSource).toContain("getGitHubPRTemplate");
    expect(catalog).toContain("Compare summary");
    expect(catalog).toContain("commits ahead");
    expect(catalog).toContain("changed files");
    expect(viewSource).toContain("setSelectedNumber(created.number)");
    expect(viewSource).not.toContain("function CreatePRForm");
  });

  test("issue state toggle does not introduce a second right-alignment spacer", () => {
    expect(viewSource).toContain('tab === "issues"');
    expect(viewSource).not.toContain('className="ml-auto flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5"');
  });

  test("list rows use the quiet hover/selected weights shared with Docker", () => {
    // Rows were hovering at bg-muted/60 and selecting at full bg-muted, which
    // read as a highlight block rather than a selection. /20 and /45 are the
    // house weights, and every row now shows a keyboard focus ring.
    for (const source of [prListSource, issueListSource, actionsSource]) {
      expect(source).toContain("hover:bg-muted/20");
      expect(source).toContain("bg-muted/45");
      expect(source).toContain("focus-visible:ring-ring");
      expect(source).not.toContain("hover:bg-muted/60");
    }
  });

  test("Branches and Actions carry no header bar of their own", () => {
    // Both had a second bar under the tab strip holding a heading that repeated
    // the tab label, the repo name the header crumb already owns, and a Refresh
    // duplicating the app header's. The whole bar is gone: the count and the
    // branch filter moved up onto the tab row, and Refresh is the header's.
    for (const source of [branchesSource, actionsSource]) {
      expect(source).not.toContain("<h2");
      expect(source).not.toContain("common.refresh");
      expect(source).not.toContain("RefreshCw");
      // …but each still answers the header Refresh, or the button that
      // replaced them would be refreshing nothing.
      expect(source).toContain("useRegisterRefresh");
      expect(source).toContain("onCountChange");
    }
    expect(viewSource).toContain("github.branches.count");
    expect(viewSource).toContain("github.actions.runCount");
    expect(viewSource).toContain("github.actions.filteredTo");
    expect(viewSource).toContain("github.actions.clearFilter");
  });

  test("Actions keeps the in-place sync as its only reload path", () => {
    // The panel button did a full reload that reset pagination; the header
    // Refresh merges a fresh page-1 fetch instead, so paged-in history
    // survives. Dropping the button must not swap that back to a hard reset.
    expect(actionsSource).toContain("useRegisterRefresh(syncLatest)");
    expect(actionsSource).not.toContain("void refresh()");
  });

  test("setup supports explicit PAT and device-flow starts", () => {
    expect(setupSource).toContain("initialMode");
    expect(setupSource).toContain('"pat"');
    expect(setupSource).toContain('"device-pending"');
  });
});
