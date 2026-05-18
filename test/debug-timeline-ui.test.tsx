import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ServicesView } from "../src/web/client/src/features/services/services-view";
import type { DashboardData } from "../src/web/client/src/lib/api";

describe("DebugTimeline UI", () => {
  test("shows recent runtime timeline events", () => {
    const data: DashboardData = {
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
      timeline: [
        {
          id: "event-1",
          timestamp: "2026-05-18T00:00:00.000Z",
          kind: "service.lifecycle",
          service: "api",
          severity: "info",
          title: "api started",
        },
      ],
      logs: [],
      git: {
        cwd: "/repo",
        selectedRepository: null,
        status: null,
        branches: [],
      },
    };

    const markup = renderToStaticMarkup(
      <ServicesView data={data} onRefresh={async () => undefined} />,
    );

    expect(markup).toContain("Runtime Monitor");
    expect(markup).toContain("api started");
    expect(markup).toContain("service.lifecycle");
  });
});
