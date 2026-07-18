import { describe, expect, test } from "vitest";
import {
  connectionInScope,
  pathInScope,
  scopeDashboard,
} from "../src/web/client/src/features/services/project-scope";
import type { DashboardData } from "../src/web/client/src/lib/api";

describe("pathInScope", () => {
  test("matches the repo root and nested directories only", () => {
    expect(pathInScope("/repo/api", "/repo/api")).toBe(true);
    expect(pathInScope("/repo/api/server", "/repo/api")).toBe(true);
    expect(pathInScope("/repo/api-v2", "/repo/api")).toBe(false);
    expect(pathInScope("/elsewhere", "/repo/api")).toBe(false);
    expect(pathInScope(undefined, "/repo/api")).toBe(false);
  });

  test("tolerates a trailing slash on the repo path", () => {
    expect(pathInScope("/repo/api/server", "/repo/api/")).toBe(true);
  });
});

describe("connectionInScope", () => {
  test("everything shows in the all-projects scope", () => {
    expect(connectionInScope("/repo/api", null)).toBe(true);
    expect(connectionInScope(undefined, null)).toBe(true);
  });

  test("scoped: keeps matching and unassigned connections, drops others", () => {
    expect(connectionInScope("/repo/api", "/repo/api")).toBe(true);
    expect(connectionInScope("/repo/api/server", "/repo/api")).toBe(true);
    expect(connectionInScope(undefined, "/repo/api")).toBe(true);
    expect(connectionInScope("/other/site", "/repo/api")).toBe(false);
  });
});

function fixture(): DashboardData {
  return {
    ok: true,
    cwd: "/repo/api",
    config: {
      services: [
        { name: "api", cwd: "/repo/api", command: "npm run dev" },
        { name: "worker", cwd: "/repo/api/worker", command: "npm start" },
        { name: "site", cwd: "/other/site", command: "npm run dev" },
        { name: "global-db", command: "docker compose up" },
      ],
      bundles: [
        { name: "backend", services: ["api", "worker", "site"] },
        { name: "frontend", services: ["site"] },
      ],
      gitRepositories: [{ name: "api", path: "/repo/api" }],
    },
    runtime: {
      services: {
        api: { name: "api", state: "running" },
        site: { name: "site", state: "running" },
      },
    },
    ports: [
      { port: 3000, available: false, hosts: [], state: "managed", services: ["api"] },
      { port: 5173, available: false, hosts: [], state: "managed", services: ["site"] },
    ],
    health: {
      api: {
        service: "api",
        status: "healthy",
        summary: "ok",
        checkedAt: "now",
        checks: [],
        ports: [],
        agentContext: "",
      },
    },
    timeline: [
      { id: "1", timestamp: "t", kind: "service.lifecycle", service: "site", severity: "info", title: "started" },
      { id: "2", timestamp: "t", kind: "git.change", severity: "info", title: "branch switched" },
    ],
    logs: [
      { service: "api", stream: "stdout", text: "listening", timestamp: "t" },
      { service: "site", stream: "stdout", text: "ready", timestamp: "t" },
    ],
    git: { cwd: "/repo/api", selectedRepository: { name: "api", path: "/repo/api" }, status: null, branches: [] },
  };
}

describe("scopeDashboard", () => {
  const scoped = scopeDashboard(fixture(), { name: "api", path: "/repo/api" });

  test("keeps only services under the repo, dropping cwd-less services", () => {
    expect(scoped.config.services.map((service) => service.name)).toEqual([
      "api",
      "worker",
    ]);
  });

  test("intersects bundles with in-scope services and drops empty ones", () => {
    expect(scoped.config.bundles).toEqual([
      { name: "backend", services: ["api", "worker"] },
    ]);
  });

  test("filters runtime, health, ports, and logs to in-scope services", () => {
    expect(Object.keys(scoped.runtime.services)).toEqual(["api"]);
    expect(Object.keys(scoped.health)).toEqual(["api"]);
    expect(scoped.ports.map((port) => port.port)).toEqual([3000]);
    expect(scoped.logs.map((entry) => entry.service)).toEqual(["api"]);
  });

  test("keeps service-less timeline events but drops out-of-scope ones", () => {
    expect(scoped.timeline.map((event) => event.id)).toEqual(["2"]);
  });
});
