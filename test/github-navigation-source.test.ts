import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const appSource = readFileSync("src/web/client/src/app.tsx", "utf8");
const gitReviewSource = readFileSync(
  "src/web/client/src/features/git/git-review-view.tsx",
  "utf8",
);

describe("GitHub top-level navigation", () => {
  test("app owns the GitHub page route", () => {
    expect(appSource).toContain('| "github"');
    expect(appSource).toContain('github: "/github"');
    expect(appSource).toContain('page === "github"');
    expect(appSource).toContain("<GitHubView");
  });

  test("github page exposes repository switching and remounts per selected repo", () => {
    // Project scope moved from the sidebar block to the header breadcrumb.
    expect(appSource).toContain("<ProjectBreadcrumb");
    expect(appSource).toContain("githubPageKey");
    expect(appSource).toContain("<GitHubView key={githubPageKey}");
  });

  test("git review no longer embeds GitHub as a tab", () => {
    expect(gitReviewSource).not.toContain('| "github"');
    expect(gitReviewSource).not.toContain("GitHubView");
    expect(gitReviewSource).not.toContain("GitHubLogo");
  });
});
