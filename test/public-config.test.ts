import { describe, expect, test } from "vitest";
import { publicConfig } from "../src/core/public-config.js";
import type { NoMoreIdeConfig } from "../src/core/types.js";

describe("publicConfig", () => {
  test("removes credentials while preserving dashboard metadata", () => {
    const config: NoMoreIdeConfig = {
      version: 1,
      services: [
        {
          name: "api",
          command: "npm run dev",
          cwd: "/repo",
          env: { API_TOKEN: "service-secret", NODE_ENV: "development" },
        },
      ],
      bundles: [],
      gitRepositories: [],
      databases: [
        {
          name: "main",
          engine: "postgres",
          url: "postgres://app:database-secret@localhost/app?sslpassword=query-secret",
        },
      ],
      logSources: [],
      sshServers: [],
      githubTokens: [
        {
          host: "github.com",
          token: "github-secret",
          login: "octocat",
        },
      ],
      githubIdentities: [],
      connections: {
        vercel: {
          source: "oauth",
          token: "access-secret",
          refreshToken: "refresh-secret",
          expiresAt: 123,
          clientId: "client_1",
          username: "octocat",
        },
      },
      workflows: [],
      workflowTriggers: [],
    };

    Object.assign(config, { futureCredential: "top-level-secret" });
    Object.assign(config.services[0] ?? {}, { futureCredential: "service-future-secret" });
    Object.assign(config.connections.vercel ?? {}, {
      futureCredential: "provider-future-secret",
    });

    const result = publicConfig(config);
    const serialized = JSON.stringify(result);

    expect(result.services[0]).not.toHaveProperty("env");
    expect(result.databases[0]?.url).toBe(
      "postgres://app:****@localhost/app?sslpassword=****",
    );
    expect(result.githubTokens).toEqual([
      { host: "github.com", login: "octocat" },
    ]);
    expect(result.connections.vercel).toEqual({
      source: "oauth",
      expiresAt: 123,
      clientId: "client_1",
      username: "octocat",
    });
    for (const secret of [
      "service-secret",
      "database-secret",
      "query-secret",
      "github-secret",
      "access-secret",
      "refresh-secret",
      "top-level-secret",
      "service-future-secret",
      "provider-future-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(config.services[0]?.env?.API_TOKEN).toBe("service-secret");
  });
});
