import { describe, expect, test, vi } from "vitest";
import {
  GitHubCliAuth,
  parseGitHubCliAccounts,
  resolveGitHubCredential,
} from "../src/core/github-auth.js";
import type { NoMoreIdeConfig } from "../src/core/types.js";

describe("GitHub CLI multi-account auth", () => {
  test("parses accounts across hosts without reading tokens", () => {
    expect(parseGitHubCliAccounts(JSON.stringify({
      hosts: {
        "github.com": [
          { login: "work", host: "github.com", active: true, state: "success" },
          { login: "personal", active: false, state: "error", ignored: "value" },
        ],
      },
    }))).toEqual([
      { login: "work", host: "github.com", active: true, state: "success" },
      { login: "personal", host: "github.com", active: false, state: "error" },
    ]);
  });

  test("retrieves the exact selected account token", async () => {
    const run = vi.fn(async () => "secret-token\n");
    const auth = new GitHubCliAuth(run);

    await expect(auth.token("github.com", "work")).resolves.toBe("secret-token");
    expect(run).toHaveBeenCalledWith([
      "auth", "token", "--hostname", "github.com", "--user", "work",
    ]);
  });

  test("does not fall back when an explicitly selected CLI account fails", async () => {
    const config = makeConfig();
    config.githubTokens.push({ host: "github.com", token: "wrong-identity" });
    const repository = {
      name: "app",
      path: "/tmp/app",
      githubCredential: { source: "gh", host: "github.com", login: "work" } as const,
    };
    const auth = new GitHubCliAuth(async () => { throw new Error("missing"); });

    await expect(resolveGitHubCredential(config, repository, "github.com", auth))
      .rejects.toThrow("@work");
  });

  test("keeps stored tokens as the backward-compatible default", async () => {
    const config = makeConfig();
    config.githubTokens.push({ host: "github.com", token: "legacy-token" });

    await expect(resolveGitHubCredential(config, undefined, "github.com"))
      .resolves.toEqual({ source: "stored", host: "github.com", token: "legacy-token" });
  });
});

function makeConfig(): NoMoreIdeConfig {
  return {
    version: 1,
    services: [],
    bundles: [],
    gitRepositories: [],
    databases: [],
    logSources: [],
    githubTokens: [],
    workflows: [],
    githubIdentities: [],
    workflowTriggers: [],
  };
}
