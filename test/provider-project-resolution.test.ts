import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  adoptSoleScope,
  readLinkedProjectId,
  resolveProviderProject,
} from "../src/core/providers/project-resolution.js";
import type { DeployProviderHooks } from "../src/core/providers/deploy-provider.js";
import type { NoMoreIdeConfig } from "../src/core/types.js";

const run = promisify(execFile);

/**
 * The three-tier ladder exercised through a provider that is not Vercel, with
 * a link file at a different path and a different field name — the two things
 * that were hard-coded before the extraction.
 */

let repo: string;

const HOOKS: DeployProviderHooks = {
  repoUrl: (remoteUrl) => (remoteUrl.includes("acme") ? `acme://${remoteUrl}` : null),
  linkFile: { path: ".acme/link.json", field: "siteId" },
};

interface FakeProject {
  id: string;
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "nomoreide-resolve-"));
  await run("git", ["init", "-q"], { cwd: repo });
  await run("git", ["remote", "add", "origin", "https://github.com/acme/web.git"], { cwd: repo });
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

function makeConfig(providerProjects?: Record<string, string>): NoMoreIdeConfig {
  return {
    version: 1,
    services: [],
    bundles: [],
    gitRepositories: providerProjects
      ? [{ name: "web", path: repo, providerProjects }]
      : [],
    databases: [],
    logSources: [],
    githubTokens: [],
    githubIdentities: [],
    workflows: [],
    workflowTriggers: [],
    connections: {},
  };
}

async function writeLinkFile(siteId: string): Promise<void> {
  await mkdir(join(repo, ".acme"), { recursive: true });
  await writeFile(join(repo, ".acme", "link.json"), JSON.stringify({ siteId }));
}

function resolve(options: {
  config?: NoMoreIdeConfig;
  getProject?: (id: string) => Promise<FakeProject>;
  findByRepoUrl?: (repoUrl: string) => Promise<FakeProject | undefined>;
}) {
  return resolveProviderProject<FakeProject>({
    providerId: "acme",
    hooks: HOOKS,
    config: options.config ?? makeConfig(),
    gitCwd: repo,
    getProject: options.getProject ?? (async (id) => ({ id })),
    findByRepoUrl: options.findByRepoUrl ?? (async () => undefined),
  });
}

describe("the project ladder tries pin, then link file, then remote", () => {
  test("an explicit pin wins over everything below it", async () => {
    await writeLinkFile("from-link-file");
    const findByRepoUrl = vi.fn(async () => ({ id: "from-remote" }));

    await expect(
      resolve({ config: makeConfig({ acme: "pinned" }), findByRepoUrl }),
    ).resolves.toEqual({ id: "pinned" });
    expect(findByRepoUrl).not.toHaveBeenCalled();
  });

  test("the pin is keyed by provider, so another provider's pin is ignored", async () => {
    await expect(
      resolve({ config: makeConfig({ vercel: "someone-elses" }) }),
    ).resolves.toBeUndefined();
  });

  test("a pin that no longer resolves falls through rather than failing", async () => {
    await writeLinkFile("from-link-file");

    await expect(
      resolve({
        config: makeConfig({ acme: "deleted-project" }),
        getProject: async (id) => {
          if (id === "deleted-project") throw new Error("404");
          return { id };
        },
      }),
    ).resolves.toEqual({ id: "from-link-file" });
  });

  test("the link file uses the provider's own path and field", async () => {
    await writeLinkFile("from-link-file");

    await expect(resolve({})).resolves.toEqual({ id: "from-link-file" });
  });

  test("the git remote is the last resort, normalized by the provider's hook", async () => {
    const findByRepoUrl = vi.fn(async () => ({ id: "from-remote" }));

    await expect(resolve({ findByRepoUrl })).resolves.toEqual({ id: "from-remote" });
    expect(findByRepoUrl).toHaveBeenCalledWith("acme://https://github.com/acme/web.git");
  });

  test("a remote the hook refuses to normalize is not looked up", async () => {
    await run("git", ["remote", "set-url", "origin", "https://example.com/other/web.git"], {
      cwd: repo,
    });
    const findByRepoUrl = vi.fn(async () => ({ id: "from-remote" }));

    await expect(resolve({ findByRepoUrl })).resolves.toBeUndefined();
    expect(findByRepoUrl).not.toHaveBeenCalled();
  });

  test("nothing answering is undefined, never a guess", async () => {
    await expect(resolve({})).resolves.toBeUndefined();
  });

  test("a provider with no link file simply skips that tier", async () => {
    await writeLinkFile("from-link-file");
    const getProject = vi.fn(async (id: string) => ({ id }));

    await expect(
      resolveProviderProject<FakeProject>({
        providerId: "acme",
        hooks: { repoUrl: HOOKS.repoUrl },
        config: makeConfig(),
        gitCwd: repo,
        getProject,
        findByRepoUrl: async () => undefined,
      }),
    ).resolves.toBeUndefined();
    expect(getProject).not.toHaveBeenCalled();
  });
});

describe("readLinkedProjectId", () => {
  test("reads the declared field, and treats a malformed file as absent", async () => {
    await writeLinkFile("site_1");
    await expect(readLinkedProjectId(repo, HOOKS.linkFile!)).resolves.toBe("site_1");

    await writeFile(join(repo, ".acme", "link.json"), "{ not json");
    await expect(readLinkedProjectId(repo, HOOKS.linkFile!)).resolves.toBeUndefined();
  });

  test("a field holding something other than a non-empty string is absent", async () => {
    await mkdir(join(repo, ".acme"), { recursive: true });
    await writeFile(join(repo, ".acme", "link.json"), JSON.stringify({ siteId: "   " }));

    await expect(readLinkedProjectId(repo, HOOKS.linkFile!)).resolves.toBeUndefined();
  });
});

describe("adoptSoleScope", () => {
  const scopes = (...ids: string[]) => ids.map((id) => ({ id, slug: `${id}-slug`, name: id }));

  test("a sole scope is adopted and persisted, making it a one-time lookup", async () => {
    const persist = vi.fn(async () => undefined);

    await expect(
      adoptSoleScope({ source: "oauth", listScopes: async () => scopes("acct_1"), persist }),
    ).resolves.toBe("acct_1");
    expect(persist).toHaveBeenCalledWith({ scopeId: "acct_1", scopeSlug: "acct_1-slug" });
  });

  test("several scopes means ask, not guess", async () => {
    const persist = vi.fn(async () => undefined);

    await expect(
      adoptSoleScope({
        source: "stored",
        listScopes: async () => scopes("acct_1", "acct_2"),
        persist,
      }),
    ).resolves.toBeUndefined();
    expect(persist).not.toHaveBeenCalled();
  });

  test("a cli credential never persists a scope, or it would override the CLI's own", async () => {
    const listScopes = vi.fn(async () => scopes("acct_1"));
    const persist = vi.fn(async () => undefined);

    await expect(adoptSoleScope({ source: "cli", listScopes, persist })).resolves.toBeUndefined();
    expect(listScopes).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  test("a CLI with no scope of its own still adopts the sole scope, in memory only", async () => {
    // Cloudflare's case: Wrangler has no account switch, so refusing to adopt
    // would leave a `wrangler login` unable to read a single project — every
    // Pages path contains an account id. Persisting it would be just as wrong,
    // because a saved scope outranks CLOUDFLARE_ACCOUNT_ID from then on.
    const persist = vi.fn(async () => undefined);

    await expect(
      adoptSoleScope({
        source: "cli",
        cliSelectsScope: false,
        listScopes: async () => scopes("acct_1"),
        persist,
      }),
    ).resolves.toBe("acct_1");
    expect(persist).not.toHaveBeenCalled();
  });

  test("a failed lookup leaves the client unscoped rather than erroring", async () => {
    await expect(
      adoptSoleScope({
        source: "oauth",
        listScopes: async () => {
          throw new Error("401");
        },
        persist: async () => undefined,
      }),
    ).resolves.toBeUndefined();
  });
});
