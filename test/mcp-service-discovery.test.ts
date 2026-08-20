import { describe, expect, test } from "vitest";
import {
  buildServiceDiscovery,
  buildServiceRegistrationResult,
} from "../src/mcp/tools/services.js";
import type { NoMoreIdeConfig } from "../src/core/types.js";

describe("MCP service discovery", () => {
  test("returns runtime definitions without exposing environment values", () => {
    const discovery = buildServiceDiscovery({
      services: [
        {
          name: "api",
          command: "npm run dev",
          cwd: "/workspace/api",
          port: 3000,
          env: {
            API_TOKEN: "secret-value",
            NODE_ENV: "development",
          },
        },
      ],
      bundles: [{ name: "app", services: ["api"] }],
    });

    expect(discovery).toEqual({
      services: [
        {
          name: "api",
          command: "npm run dev",
          cwd: "/workspace/api",
          port: 3000,
          envKeys: ["API_TOKEN", "NODE_ENV"],
        },
      ],
      bundles: [{ name: "app", services: ["api"] }],
    });
    expect(JSON.stringify(discovery)).not.toContain("secret-value");
  });

  test("redacts environment values from registration responses", () => {
    const config: NoMoreIdeConfig = {
      version: 1,
      services: [
        {
          name: "existing",
          command: "npm run existing",
          cwd: "/workspace/existing",
          env: { EXISTING_TOKEN: "existing-secret-value" },
        },
        {
          name: "new-service",
          command: "npm run dev",
          cwd: "/workspace/new-service",
          env: { NEW_TOKEN: "new-secret-value" },
        },
      ],
      bundles: [{ name: "app", services: ["new-service"] }],
      gitRepositories: [],
      databases: [],
      logSources: [],
      sshServers: [],
      githubTokens: [],
      githubIdentities: [],
      connections: {},
      workflows: [],
      workflowTriggers: [],
    };

    const result = buildServiceRegistrationResult(config);
    const serialized = JSON.stringify(result);

    expect(result.services).toEqual([
      {
        name: "existing",
        command: "npm run existing",
        cwd: "/workspace/existing",
      },
      {
        name: "new-service",
        command: "npm run dev",
        cwd: "/workspace/new-service",
      },
    ]);
    expect(serialized).not.toContain("existing-secret-value");
    expect(serialized).not.toContain("new-secret-value");
    expect(config.services[1]?.env).toEqual({ NEW_TOKEN: "new-secret-value" });
  });
});
