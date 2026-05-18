import { describe, expect, test } from "vitest";
import { computeServiceHealth } from "../src/core/service-health.js";

describe("computeServiceHealth", () => {
  test("marks high memory services as warning", () => {
    const health = computeServiceHealth({
      service: { name: "frontend", command: "npm run dev", cwd: "/app", port: 5001 },
      status: {
        name: "frontend",
        state: "running",
        processTree: {
          rootPid: 10,
          processCount: 3,
          cpuPercent: 0,
          rssMb: 1220,
          processes: [],
        },
      },
      ports: [{ port: 5001, available: false, hosts: [] }],
      logs: [],
    });

    expect(health.status).toBe("warning");
    expect(health.summary).toContain("memory");
  });

  test("marks exited services as unhealthy", () => {
    const health = computeServiceHealth({
      service: { name: "api", command: "npm run api", cwd: "/app", port: 3001 },
      status: { name: "api", state: "exited", exitCode: 1 },
      ports: [],
      logs: [],
    });

    expect(health.status).toBe("unhealthy");
    expect(health.summary).toContain("exited");
  });
});
