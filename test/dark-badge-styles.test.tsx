import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { Badge } from "../src/web/client/src/components/ui/badge";
import { OperationProvider } from "../src/web/client/src/components/operations/operation-context";
import { AgentProvider } from "../src/web/client/src/features/agent/chat/agent-context";
import { CommitList } from "../src/web/client/src/features/git/git-graph/commit-list";
import { ProcessBadge } from "../src/web/client/src/features/services/process-badge";
import { ServiceRow } from "../src/web/client/src/features/services/service-list";
import type { GitGraphCommit } from "../src/web/client/src/lib/api";

const rowRefs = { current: new Map<string, HTMLLIElement>() };

function buildCommit(): GitGraphCommit {
  return {
    hash: "83bf42a9f6a134a7c03d03f5cb1db13abc123456",
    parents: [],
    author: "Robert",
    email: "robert@example.com",
    timestamp: Math.floor(Date.now() / 1000),
    subject: "feat: onboard a repo from a URL via the agent dock",
    refs: [
      { kind: "head", name: "HEAD" },
      { kind: "branch", name: "main" },
      { kind: "remote", name: "origin/main" },
      { kind: "tag", name: "v0.1.41" },
    ],
    lane: 0,
    laneCount: 1,
    edges: [],
    throughLanes: [],
  };
}

describe("dark badge styles", () => {
  test("shared badges use the shadcn shape and token-based surfaces", () => {
    const markup = renderToStaticMarkup(
      <>
        <Badge variant="outline">origin/main</Badge>
        <Badge variant="secondary">14</Badge>
        <Badge variant="success">HEAD</Badge>
        <Badge variant="warning">v0.1.41</Badge>
      </>,
    );

    expect(markup).toContain("rounded-md");
    expect(markup).toContain("border-border");
    expect(markup).toContain("bg-secondary");
    expect(markup).toContain("dark:bg-emerald-500/15");
    expect(markup).toContain("dark:bg-amber-500/15");
    expect(markup).not.toContain("shadow-[");
  });

  test("git ref badges avoid light backgrounds in dark mode", () => {
    const markup = renderToStaticMarkup(
      <AgentProvider>
        <CommitList
          commits={[buildCommit()]}
          error={null}
          loading={false}
          maxLanes={1}
          onLoadMore={vi.fn()}
          onSelect={vi.fn()}
          rowRefs={rowRefs}
          selectedHash={null}
        />
      </AgentProvider>,
    );

    expect(markup).toContain("dark:bg-emerald-500/15");
    expect(markup).toContain("dark:bg-blue-500/15");
    expect(markup).toContain("dark:bg-zinc-800/80");
    expect(markup).toContain("dark:bg-amber-500/15");
  });

  test("process badges keep a light brand tile in dark mode", () => {
    const nodeBadge = renderToStaticMarkup(<ProcessBadge command="npm run dev" />);
    const genericBadge = renderToStaticMarkup(<ProcessBadge command="./server" />);

    expect(nodeBadge).toContain("dark:bg-zinc-100");
    expect(genericBadge).toContain("dark:bg-zinc-100");
    expect(genericBadge).toContain("dark:text-zinc-700");
  });

  test("service rows reserve a fixed logo column", () => {
    const markup = renderToStaticMarkup(
      <OperationProvider>
        <ServiceRow
          onRefresh={async () => undefined}
          service={{
            name: "jobjourney-api",
            command: "npm run dev",
            cwd: "/repo",
            kind: "local",
          }}
          status={{ state: "running", pid: 1234 }}
        />
      </OperationProvider>,
    );

    expect(markup).toContain("grid-cols-[1.75rem_minmax(0,1fr)_auto]");
    expect(markup).toContain("items-center");
  });
});
