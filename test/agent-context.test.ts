import { describe, expect, test } from "vitest";
import { buildServiceAgentContext } from "../src/core/agent-context.js";

describe("buildServiceAgentContext", () => {
  test("includes command, cwd, health summary, recent stderr, and timeline", () => {
    const context = buildServiceAgentContext({
      service: {
        name: "frontend",
        command: "npm run dev",
        cwd: "/repo/client",
        port: 5001,
      },
      status: {
        name: "frontend",
        state: "running",
        url: "http://localhost:5001/",
        pid: 1234,
      },
      healthSummary: "High memory usage: 1220 MB RSS.",
      recentLogs: [
        {
          service: "frontend",
          stream: "stdout",
          text: "VITE v8.0.3 ready in 126 ms",
          timestamp: "2026-05-18T00:00:00.000Z",
        },
        {
          service: "frontend",
          stream: "stderr",
          text: "warning: deprecated API used",
          timestamp: "2026-05-18T00:01:00.000Z",
        },
      ],
      timeline: [
        {
          id: "evt-1",
          timestamp: "2026-05-18T00:01:30.000Z",
          kind: "service.lifecycle",
          service: "frontend",
          severity: "info",
          title: "frontend started",
        },
        {
          id: "evt-2",
          timestamp: "2026-05-18T00:02:00.000Z",
          kind: "service.log",
          service: "frontend",
          severity: "warning",
          title: "frontend stderr",
          detail: "warning: deprecated API used",
        },
      ],
    });

    expect(context).toContain("frontend");
    expect(context).toContain("npm run dev");
    expect(context).toContain("/repo/client");
    expect(context).toContain("5001");
    expect(context).toContain("running");
    expect(context).toContain("High memory usage");
    expect(context).toContain("deprecated API");
    expect(context).toContain("frontend started");
    // Headed sections
    expect(context).toMatch(/Service:/);
    expect(context).toMatch(/Health:/);
    expect(context).toMatch(/Recent logs:/);
    expect(context).toMatch(/Recent timeline:/);
  });

  test("renders placeholders when status, logs, and timeline are missing", () => {
    const context = buildServiceAgentContext({
      service: {
        name: "api",
        command: "node server.js",
        cwd: "/repo/api",
      },
      healthSummary: "Service is not running.",
      recentLogs: [],
      timeline: [],
    });

    expect(context).toContain("api");
    expect(context).toContain("Service is not running.");
    expect(context).toMatch(/Recent logs:\n- none/);
    expect(context).toMatch(/Recent timeline:\n- none/);
  });
});
