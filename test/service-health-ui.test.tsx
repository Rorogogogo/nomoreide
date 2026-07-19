import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { AgentProvider } from "../src/web/client/src/features/agent/chat/agent-context";
import { OperationProvider } from "../src/web/client/src/components/operations/operation-context";
import { ServicesView } from "../src/web/client/src/features/services/services-view";
import type { DashboardData, ServiceHealth } from "../src/web/client/src/lib/api";

function buildDashboard(health: ServiceHealth): DashboardData {
  return {
    ok: true,
    cwd: "/repo",
    config: {
      services: [
        {
          name: "frontend",
          command: "npm run dev",
          cwd: "/repo/client",
          port: 5001,
        },
      ],
      bundles: [],
      gitRepositories: [],
    },
    runtime: {
      services: {
        frontend: {
          name: "frontend",
          state: "running",
          pid: 10,
          processTree: health.processTree,
        },
      },
    },
    ports: [],
    logs: [],
    health: { frontend: health },
    timeline: [],
    git: {
      cwd: "/repo",
      selectedRepository: null,
      status: null,
      branches: [],
    },
  } as unknown as DashboardData;
}

function renderServicesView(data: DashboardData) {
  return renderToStaticMarkup(
    <AgentProvider>
      <OperationProvider>
        <ServicesView data={data} onRefresh={async () => undefined} />
      </OperationProvider>
    </AgentProvider>,
  );
}

describe("service health UI", () => {
  test("detail header shows warning, process count, CPU, and RAM", () => {
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

    const markup = renderServicesView(buildDashboard(health));

    expect(markup).toContain("warning");
    expect(markup).toContain("High memory usage");
    expect(markup).toContain("3 processes");
    expect(markup).toContain("1.7% CPU");
    expect(markup).toContain("1220 MB RAM");
    expect(markup).toContain("health-metrics");
    expect(markup).not.toContain("Diagnostics");
  });

  test("formats zero CPU with one decimal place", () => {
    const health: ServiceHealth = {
      service: "frontend",
      status: "healthy",
      summary: "Service is running without detected warnings.",
      checkedAt: "2026-05-18T00:00:00.000Z",
      checks: [],
      processTree: {
        rootPid: 10,
        processCount: 2,
        cpuPercent: 0,
        rssMb: 507.7,
        processes: [],
      },
      ports: [],
      agentContext: "",
    };

    const markup = renderServicesView(buildDashboard(health));

    expect(markup).toContain("0.0% CPU");
  });

  test("shows the service side rail by default", () => {
    const health: ServiceHealth = {
      service: "frontend",
      status: "healthy",
      summary: "Service is running without detected warnings.",
      checkedAt: "2026-05-18T00:00:00.000Z",
      checks: [],
      processTree: {
        rootPid: 10,
        processCount: 2,
        cpuPercent: 0,
        rssMb: 507.7,
        processes: [],
      },
      ports: [],
      agentContext: "",
    };

    const markup = renderServicesView(buildDashboard(health));

    expect(markup).toContain("Ports");
    expect(markup).toContain("Runtime Monitor");
    expect(markup).toContain("Hide Ports &amp; Timeline");
  });

  test("keeps the selected service header compact when the side rail is visible", () => {
    const health: ServiceHealth = {
      service: "frontend",
      status: "healthy",
      summary: "Service is running without detected warnings.",
      checkedAt: "2026-05-18T00:00:00.000Z",
      checks: [],
      processTree: {
        rootPid: 10,
        processCount: 2,
        cpuPercent: 0,
        rssMb: 507.7,
        processes: [],
      },
      ports: [],
      agentContext: "",
    };

    const markup = renderServicesView(buildDashboard(health));

    expect(markup).not.toContain("Port for frontend");
    expect(markup).toContain("More actions for frontend");
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

    expect(() => renderServicesView(data)).not.toThrow();
  });
});
