import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ServiceRow } from "../src/web/client/src/features/services/service-list";
import { ServicesView } from "../src/web/client/src/features/services/services-view";
import type { DashboardData, ServiceHealth } from "../src/web/client/src/lib/api";

describe("service health UI", () => {
  test("keeps row health compact and puts diagnostics behind details", () => {
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
    expect(markup).toContain("Diagnostics");
    expect(markup).toContain("3 processes");
    expect(markup).toContain("1220 MB RSS");
    expect(markup.indexOf("warning")).toBeLessThan(markup.indexOf("Diagnostics"));
  });

  test("renders services when dashboard health data is missing", () => {
    const data = {
      ok: true,
      cwd: "/repo",
      config: {
        services: [
          {
            name: "nomoreide-website",
            command: "npm run dev",
            cwd: "/repo/website",
            port: 5174,
          },
        ],
        bundles: [],
        gitRepositories: [],
      },
      runtime: { services: {} },
      ports: [],
      logs: [],
      git: {
        cwd: "/repo",
        selectedRepository: null,
        status: null,
        branches: [],
      },
    } as unknown as DashboardData;

    expect(() =>
      renderToStaticMarkup(
        <ServicesView data={data} onRefresh={async () => undefined} />,
      ),
    ).not.toThrow();
  });
});
