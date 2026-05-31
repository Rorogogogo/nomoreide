import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { AgentProvider } from "../src/web/client/src/features/agent/chat/agent-context";
import { GitReviewView } from "../src/web/client/src/features/git/git-review-view";
import type { DashboardData } from "../src/web/client/src/lib/api";

function buildDashboardData(): DashboardData {
  return {
    ok: true,
    cwd: "/repo",
    config: {
      services: [],
      bundles: [],
      gitRepositories: [],
    },
    runtime: { services: {} },
    ports: [],
    logs: [],
    timeline: [],
    git: {
      cwd: "/repo",
      selectedRepository: { name: "repo", path: "/repo" },
      branches: [],
      status: {
        branch: "main",
        files: [
          { path: "src/app.tsx", index: " ", workingTree: "M" },
          { path: "README.md", index: "?", workingTree: "?" },
        ],
      },
    },
  } as unknown as DashboardData;
}

describe("GitReviewView", () => {
  test("keeps all-files separate from the changed-files view modes", () => {
    const markup = renderToStaticMarkup(
      <AgentProvider>
        <GitReviewView data={buildDashboardData()} />
      </AgentProvider>,
    );

    expect(markup).toContain("Show changed files as a list");
    expect(markup).toContain("Show changed files as a tree");
    expect(markup).toContain("Open all tracked files");
    expect(markup).toContain("Send selected file to AI input");
    expect(markup).not.toContain("Show all tracked files");
  });
});
