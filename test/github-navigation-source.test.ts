import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const appSource = readFileSync("apps/dashboard/src/app.tsx", "utf8");
// The page→path map moved to its own feature-agnostic module.
const appRoutingSource = readFileSync("apps/dashboard/src/app-routing.ts", "utf8");
const appNavigationSource = readFileSync(
  "apps/dashboard/src/components/app-navigation.tsx",
  "utf8",
);
const gitReviewSource = readFileSync(
  "apps/dashboard/src/features/git/git-review-view.tsx",
  "utf8",
);

describe("GitHub top-level navigation", () => {
  test("app owns the GitHub page route", () => {
    expect(appNavigationSource).toContain('| "github"');
    expect(appRoutingSource).toContain('github: "/github"');
    expect(appSource).toContain('page === "github"');
    expect(appSource).toContain("<GitHubView");
  });

  test("github page exposes repository switching and remounts per selected repo", () => {
    // Project scope moved from the sidebar block to the header breadcrumb.
    expect(appSource).toContain("<ProjectBreadcrumb");
    expect(appSource).toContain("repoScopeKey");
    expect(appSource).toContain("<GitHubView key={repoScopeKey}");
  });

  test("all-project overviews remount per domain so each page shows its loader", () => {
    expect(appSource).toContain("<ProjectOverviewTable");
    expect(appSource).toContain("key={overviewDomain}");
  });

  test("git review no longer embeds GitHub as a tab", () => {
    expect(gitReviewSource).not.toContain('| "github"');
    expect(gitReviewSource).not.toContain("GitHubView");
    expect(gitReviewSource).not.toContain("GitHubLogo");
  });
});
