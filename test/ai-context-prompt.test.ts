import { describe, expect, test } from "vitest";
import {
  buildAiContextLabel,
  buildAiContextPrompt,
} from "../src/web/client/src/features/agent/prompts/ai-context";
import type { DashboardData, DatabaseConnection, ErrorIncident } from "../src/web/client/src/lib/api";

const dashboard = {
  cwd: "/workspace/nomoreide",
  config: {
    services: [
      {
        name: "web",
        kind: "local",
        command: "npm run dev",
        cwd: "/workspace/nomoreide/web",
        port: 5173,
      },
      {
        name: "api",
        kind: "docker-compose",
        command: "docker compose up api",
        cwd: "/workspace/nomoreide",
        port: 3000,
      },
    ],
    bundles: [],
    gitRepositories: [
      { name: "nomoreide", path: "/workspace/nomoreide" },
      { name: "website", path: "/workspace/website" },
    ],
  },
  runtime: {
    services: {
      web: { name: "web", state: "running", pid: 123, url: "http://localhost:5173" },
      api: { name: "api", state: "exited", exitCode: 1 },
    },
  },
  health: {
    web: {
      service: "web",
      status: "healthy",
      summary: "HTTP check passed",
      checkedAt: "2026-06-01T00:00:00.000Z",
      checks: [],
      ports: [],
      agentContext: "web debug context",
    },
    api: {
      service: "api",
      status: "unhealthy",
      summary: "Container exited",
      checkedAt: "2026-06-01T00:00:00.000Z",
      checks: [],
      ports: [],
      agentContext: "api debug context",
    },
  },
  ports: [],
  timeline: [],
  logs: [{ service: "api", stream: "stderr", text: "boom", timestamp: "now" }],
  git: {
    cwd: "/workspace/nomoreide",
    selectedRepository: { name: "nomoreide", path: "/workspace/nomoreide" },
    status: {
      branch: "main",
      files: [{ path: "src/app.tsx", status: "modified" }],
    },
    branches: [],
  },
  ok: true,
} satisfies DashboardData;

const databases: DatabaseConnection[] = [
  { name: "app-db", engine: "postgres", url: "postgres://***@localhost/app" },
];

const incidents: ErrorIncident[] = [
  {
    id: 42,
    service: "api",
    level: "error",
    signature: "api-crash",
    title: "TypeError in checkout",
    firstSeen: "2026-06-01T00:00:00.000Z",
    lastSeen: "2026-06-01T00:01:00.000Z",
    count: 3,
    logExcerpt: ["TypeError: missing cart id"],
  },
];

describe("AI context prompt", () => {
  test("combines services, databases, errors, and git into one developer prompt", () => {
    const prompt = buildAiContextPrompt({
      dashboard,
      databases,
      incidents,
      note: "Checkout is failing after login",
      selection: {
        databaseNames: ["app-db"],
        errorIds: [42],
        repositoryPaths: ["/workspace/nomoreide", "/workspace/website"],
        serviceNames: ["web", "api"],
      },
    });

    expect(prompt).toContain("Diagnose this NoMoreIDE workspace context");
    expect(prompt).toContain("Workspace: /workspace/nomoreide");
    expect(prompt).toContain("Extra user context:\nCheckout is failing after login");
    expect(prompt).toContain("Services");
    expect(prompt).toContain("Service: api");
    expect(prompt).toContain("state: exited");
    expect(prompt).toContain("agent debug context:\napi debug context");
    expect(prompt).toContain("Databases");
    expect(prompt).toContain("Database: app-db");
    expect(prompt).toContain("engine: postgres");
    expect(prompt).toContain("Error Inbox");
    expect(prompt).toContain("Incident #42");
    expect(prompt).toContain("TypeError in checkout");
    expect(prompt).toContain("Git Repositories");
    expect(prompt).toContain("Repository: nomoreide");
    expect(prompt).toContain("path: /workspace/nomoreide");
    expect(prompt).toContain("Repository: website");
    expect(prompt).toContain("path: /workspace/website");
    expect(prompt).toContain("src/app.tsx");
    expect(prompt).not.toContain("branch: main");

    expect(
      buildAiContextLabel({
        note: "Checkout is failing after login",
        selection: {
          databaseNames: ["app-db"],
          errorIds: [42],
          repositoryPaths: ["/workspace/nomoreide", "/workspace/website"],
          serviceNames: ["web", "api"],
        },
      }),
    ).toBe("Diagnose: 2 services, 1 database, 1 error, 2 repos. Note: Checkout is failing after login");
  });
});
