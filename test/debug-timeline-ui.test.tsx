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
  test("renders a graph rail with markers colored by severity", () => {
    const data = buildData([
      {
        id: "event-1",
        timestamp: "2026-05-18T00:00:00.000Z",
        kind: "service.lifecycle",
        service: "api",
        severity: "info",
        title: "api started",
      },
      {
        id: "event-2",
        timestamp: "2026-05-18T00:05:00.000Z",
        kind: "service.lifecycle",
        service: "api",
        severity: "warning",
        title: "api degraded",
      },
      {
        id: "event-3",
        timestamp: "2026-05-18T00:10:00.000Z",
        kind: "service.lifecycle",
        service: "api",
        severity: "error",
        title: "api crashed",
      },
    ]);

    const markup = renderToStaticMarkup(
      <ServicesView data={data} onRefresh={async () => undefined} />,
    );

    expect(markup).toContain("Runtime Monitor");
    // Graph rail container
    expect(markup).toContain("timeline-graph");
    expect(markup).toContain("timeline-rail");
    // Three markers, one per event
    const markerCount = (markup.match(/timeline-marker/g) || []).length;
    expect(markerCount).toBeGreaterThanOrEqual(3);
    // Severity colors
    expect(markup).toContain("bg-red-500");
    expect(markup).toContain("bg-amber-500");
    // Labels still available
    expect(markup).toContain("api started");
    expect(markup).toContain("api crashed");
    expect(markup).toContain("service.lifecycle");
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
