import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ServiceRow } from "../src/web/client/src/features/services/service-list";
import type { ServiceHealth } from "../src/web/client/src/lib/api";

describe("service health UI", () => {
  test("shows health summary and process resources on service rows", () => {
    const health: ServiceHealth = {
      service: "frontend",
      status: "warning",
      summary: "High memory usage: 1220.0 MB RSS.",
      checkedAt: "2026-05-18T00:00:00.000Z",
      checks: [],
      processTree: {
        rootPid: 10,
        processCount: 3,
        cpuPercent: 1.7,
        rssMb: 1220,
        processes: [],
      },
      ports: [],
      agentContext: "",
    };

    const markup = renderToStaticMarkup(
      <ServiceRow
        health={health}
        onRefresh={async () => undefined}
        ports={[]}
        service={{
          name: "frontend",
          command: "npm run dev",
          cwd: "/repo/client",
          port: 5001,
        }}
        status={{
          name: "frontend",
          state: "running",
          pid: 10,
          processTree: health.processTree,
        }}
      />,
    );

    expect(markup).toContain("warning");
    expect(markup).toContain("High memory usage");
    expect(markup).toContain("3 processes");
    expect(markup).toContain("1220 MB RSS");
  });
});
