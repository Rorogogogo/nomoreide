import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ServicesView } from "../src/web/client/src/features/services/services-view";
import type { DashboardData, TimelineEvent } from "../src/web/client/src/lib/api";

function buildData(timeline: TimelineEvent[]): DashboardData {
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
    health: {},
    timeline,
    logs: [],
    git: {
      cwd: "/repo",
      selectedRepository: null,
      status: null,
      branches: [],
    },
  };
}

describe("DebugTimeline UI", () => {
  test("renders a per-service row with counts, density bars, and the last warning message", () => {
    const now = Date.now();
    const data = buildData([
      {
        id: "event-1",
        timestamp: new Date(now - 12 * 60 * 1000).toISOString(),
        kind: "service.lifecycle",
        service: "brainctl-platform-frontend",
        severity: "info",
        title: "brainctl-platform-frontend started",
      },
      {
        id: "event-2",
        timestamp: new Date(now - 3 * 60 * 1000).toISOString(),
        kind: "service.log",
        service: "jobjourney-api",
        severity: "warning",
        title: "jobjourney-api stderr",
        detail: "deprecated API used: getThing()",
      },
      {
        id: "event-3",
        timestamp: new Date(now - 30 * 1000).toISOString(),
        kind: "service.log",
        service: "jobjourney-api",
        severity: "error",
        title: "jobjourney-api stderr",
        detail: "EADDRINUSE: address already in use 0.0.0.0:5173",
      },
    ]);

    const markup = renderToStaticMarkup(
      <ServicesView data={data} onRefresh={async () => undefined} />,
    );

    expect(markup).toContain("Runtime Monitor");
    // Two service rows
    const rowCount = (markup.match(/data-testid="timeline-service-row"/g) || []).length;
    expect(rowCount).toBe(2);
    // Density buckets render per row
    expect(markup).toContain("timeline-density");
    // Full service names should be readable (not truncated in markup)
    expect(markup).toContain("brainctl-platform-frontend");
    expect(markup).toContain("jobjourney-api");
    // Latest error/warning message surfaces inline
    expect(markup).toContain("EADDRINUSE");
    // Severity color used in row pill
    expect(markup).toContain("bg-red-500");
  });

  test("shows empty state when there are no events", () => {
    const data = buildData([]);
    const markup = renderToStaticMarkup(
      <ServicesView data={data} onRefresh={async () => undefined} />,
    );
    expect(markup).toContain("Runtime Monitor");
    expect(markup).toContain("No runtime timeline events yet.");
  });
});
