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

  test("ignores stderr lines that are not errors", () => {
    const health = computeServiceHealth({
      service: { name: "api", command: "go run ./cmd/server", cwd: "/app", port: 8080 },
      status: { name: "api", state: "running", startedAt: "2026-07-11T01:00:00.000Z" },
      ports: [],
      logs: [
        {
          service: "api",
          stream: "stderr",
          text: "2026/07/11 11:20:44 listening on :8080",
          timestamp: "2026-07-11T01:20:44.888Z",
        },
      ],
    });

    expect(health.status).toBe("healthy");
  });

  test("ignores error logs from before the current run", () => {
    const health = computeServiceHealth({
      service: { name: "api", command: "go run ./cmd/server", cwd: "/app", port: 8080 },
      status: { name: "api", state: "running", startedAt: "2026-07-11T01:26:44.363Z" },
      ports: [],
      logs: [
        {
          service: "api",
          stream: "stderr",
          text: "listen tcp :8080: bind: address already in use — exit status 1",
          timestamp: "2026-07-11T01:20:44.888Z",
        },
      ],
    });

    expect(health.status).toBe("healthy");
  });

  test("flags error logs from the current run", () => {
    const health = computeServiceHealth({
      service: { name: "api", command: "go run ./cmd/server", cwd: "/app", port: 8080 },
      status: { name: "api", state: "running", startedAt: "2026-07-11T01:00:00.000Z" },
      ports: [],
      logs: [
        {
          service: "api",
          stream: "stdout",
          text: "ERROR: database connection lost",
          timestamp: "2026-07-11T01:20:44.888Z",
        },
      ],
    });

    expect(health.status).toBe("warning");
    expect(health.summary).toContain("database connection lost");
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
