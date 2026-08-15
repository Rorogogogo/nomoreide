import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  __recoverStaleConfigLockForTests,
  ConfigStore,
} from "../src/core/config-store.js";

const execFileAsync = promisify(execFile);

let tempDir: string;
let configPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-config-"));
  configPath = join(tempDir, "nomoreide.config.json");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("ConfigStore", () => {
  test("round-trips optional project preferences", async () => {
    const store = new ConfigStore(configPath);

    await store.updatePreferences({
      logs: { showTimestamps: false, wrapLines: false },
      database: { confirmWrites: false, resultLimit: 250 },
    });

    expect((await store.load()).preferences).toEqual({
      logs: { showTimestamps: false, wrapLines: false },
      database: { confirmWrites: false, resultLimit: 250 },
    });
  });

  test("exposes independent safe defaults when preferences are absent", async () => {
    const store = new ConfigStore(configPath);

    const first = await store.getPreferences();
    first.logs.wrapLines = false;

    expect(await store.getPreferences()).toEqual({
      logs: { showTimestamps: true, wrapLines: true },
      database: { confirmWrites: true, resultLimit: 100 },
    });
    expect((await store.load()).preferences).toBeUndefined();
  });

  test("partially updates preferences without changing other config", async () => {
    const store = new ConfigStore(configPath);
    await store.registerBundle({ name: "stack", services: ["api"] });
    await store.updatePreferences({ logs: { showTimestamps: false } });

    const preferences = await store.updatePreferences({
      database: { resultLimit: 750 },
    });

    expect(preferences).toEqual({
      logs: { showTimestamps: false, wrapLines: true },
      database: { confirmWrites: true, resultLimit: 750 },
    });
    expect((await store.load()).bundles).toEqual([
      { name: "stack", services: ["api"] },
    ]);
  });

  test("reset removes persisted preference overrides and returns defaults", async () => {
    const store = new ConfigStore(configPath);
    await store.updatePreferences({ database: { resultLimit: 300 } });

    expect(await store.resetPreferences()).toEqual({
      logs: { showTimestamps: true, wrapLines: true },
      database: { confirmWrites: true, resultLimit: 100 },
    });
    expect((await store.load()).preferences).toBeUndefined();
    expect(JSON.parse(await readFile(configPath, "utf8"))).not.toHaveProperty(
      "preferences",
    );
  });

  test("does not persist invalid project result limits", async () => {
    const store = new ConfigStore(configPath);
    await store.updatePreferences({ database: { resultLimit: 200 } });
    const before = await readFile(configPath, "utf8");

    await expect(
      store.updatePreferences({ database: { resultLimit: 5 } }),
    ).rejects.toThrow();

    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  test("serializes preference updates with other config mutations", async () => {
    const store = new ConfigStore(configPath);

    await Promise.all([
      store.updatePreferences({ logs: { wrapLines: false } }),
      store.registerBundle({ name: "stack", services: ["api"] }),
    ]);

    const config = await store.load();
    expect(config.preferences?.logs.wrapLines).toBe(false);
    expect(config.bundles).toEqual([{ name: "stack", services: ["api"] }]);
  });

  test("serializes mutations across stores sharing a config file", async () => {
    for (let iteration = 0; iteration < 10; iteration += 1) {
      const sharedPath = join(tempDir, `shared-${iteration}.json`);
      const preferencesStore = new ConfigStore(sharedPath);
      const bundleStore = new ConfigStore(sharedPath);

      await Promise.all([
        preferencesStore.updatePreferences({
          database: { resultLimit: 100 + iteration },
        }),
        bundleStore.registerBundle({
          name: `stack-${iteration}`,
          services: ["api"],
        }),
      ]);

      const raw = JSON.parse(await readFile(sharedPath, "utf8"));
      expect(raw.preferences.database.resultLimit).toBe(100 + iteration);
      expect(raw.bundles).toEqual([
        { name: `stack-${iteration}`, services: ["api"] },
      ]);
    }
  });

  test("releases cross-store coordination after a failed mutation", async () => {
    const first = new ConfigStore(configPath);
    const second = new ConfigStore(configPath);

    await expect(first.removeService("missing")).rejects.toThrow(
      /not registered/,
    );
    const preferences = await Promise.race([
      second.updatePreferences({ logs: { wrapLines: false } }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("mutation remained blocked")), 1_000);
      }),
    ]);

    expect(preferences.logs.wrapLines).toBe(false);
    await expect(readFile(`${configPath}.lock`, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("recovers an abandoned stale config lock", async () => {
    const lockPath = `${configPath}.lock`;
    await writeFile(lockPath, "abandoned-owner");
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleTime, staleTime);

    await new ConfigStore(configPath).updatePreferences({
      logs: { showTimestamps: false },
    });

    expect((await new ConfigStore(configPath).getPreferences()).logs).toEqual({
      showTimestamps: false,
      wrapLines: true,
    });
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("stale recovery preserves a replacement lock owner", async () => {
    const lockPath = `${configPath}.lock`;
    const replacementPath = `${lockPath}.replacement`;
    const staleTime = new Date(Date.now() - 60_000);
    await writeFile(lockPath, "old-owner");
    await utimes(lockPath, staleTime, staleTime);

    await __recoverStaleConfigLockForTests(lockPath, async () => {
      await writeFile(replacementPath, "new-owner");
      await rename(replacementPath, lockPath);
      await utimes(lockPath, staleTime, staleTime);
    });

    expect(await readFile(lockPath, "utf8")).toBe("new-owner");
  });

  test("creates a default config when the file does not exist", async () => {
    const store = new ConfigStore(configPath);

    const config = await store.load();

    expect(config).toEqual({
      version: 1,
      services: [],
      bundles: [],
      gitRepositories: [],
      databases: [],
      logSources: [],
      sshServers: [],
      githubTokens: [],
      workflows: [],
      githubIdentities: [],
      workflowTriggers: [],
      connections: {},
    });
  });

  test("registers, masks, and removes a database connection", async () => {
    const store = new ConfigStore(configPath);

    await store.registerDatabase({
      name: "shop",
      engine: "postgres",
      url: "postgres://user:secret@localhost:5432/shop",
      projectPath: "/repo/shop",
    });

    let config = await store.load();
    expect(config.databases).toEqual([
      {
        name: "shop",
        engine: "postgres",
        url: "postgres://user:secret@localhost:5432/shop",
        projectPath: "/repo/shop",
      },
    ]);

    await store.removeDatabase("shop");
    config = await store.load();
    expect(config.databases).toEqual([]);
  });

  test("registers and removes log sources of each kind", async () => {
    const store = new ConfigStore(configPath);

    await store.registerLogSource({ name: "PROD", kind: "ssh", host: "prod", path: "/var/log/app.log" });
    await store.registerLogSource({ name: "local", kind: "file", path: "/tmp/app.log" });
    await store.registerLogSource({ name: "journal", kind: "command", command: "journalctl -n 200" });

    let config = await store.load();
    expect(config.logSources.map((s) => s.name).sort()).toEqual(["PROD", "journal", "local"]);

    await store.removeLogSource("PROD");
    config = await store.load();
    expect(config.logSources.map((s) => s.name).sort()).toEqual(["journal", "local"]);
  });

  test("rejects a log source missing required fields for its kind", async () => {
    const store = new ConfigStore(configPath);
    await expect(store.registerLogSource({ name: "bad", kind: "ssh", host: "prod" })).rejects.toThrow();
  });

  test("persists an explicit project assignment", async () => {
    const store = new ConfigStore(configPath);

    await store.registerService({
      name: "jobjourney-prod-logs",
      kind: "ssh",
      host: "prod",
      command: "tail -f app.log",
      cwd: "/var/www/jobjourney-server",
      projectPath: "/Users/dev/work/JJ/JobJourney",
    });

    const [service] = (await store.load()).services;
    expect(service.projectPath).toBe("/Users/dev/work/JJ/JobJourney");
  });

  test("leaves the project assignment absent when not given", async () => {
    // Absent means "infer from cwd", so it must not be persisted as empty.
    const store = new ConfigStore(configPath);

    await store.registerService({ name: "web", command: "npm run dev", cwd: "/repo" });

    const raw = JSON.parse(await readFile(configPath, "utf8"));
    expect(raw.services[0]).not.toHaveProperty("projectPath");
  });

  test("rejects a blank project assignment", async () => {
    const store = new ConfigStore(configPath);

    await expect(
      store.registerService({ name: "web", command: "npm run dev", cwd: "/repo", projectPath: "" }),
    ).rejects.toThrow();
  });

  test("setServiceProject patches only the assignment", async () => {
    // Reassignment must not require resending the definition, or fields the
    // caller does not know about would be dropped.
    const store = new ConfigStore(configPath);
    await store.registerService({
      name: "api",
      kind: "ssh",
      host: "prod",
      command: "npm start",
      cwd: "/srv/api",
      port: 3000,
      description: "API",
      dependsOn: [],
      test: "npm run check",
    });

    await store.setServiceProject("api", "/repos/acme");

    const [service] = (await store.load()).services;
    expect(service).toMatchObject({
      projectPath: "/repos/acme",
      host: "prod",
      command: "npm start",
      cwd: "/srv/api",
      port: 3000,
      description: "API",
      test: "npm run check",
    });
  });

  test("setServiceProject clears the assignment when blank", async () => {
    const store = new ConfigStore(configPath);
    await store.registerService({
      name: "api",
      command: "npm start",
      cwd: "/repo",
      projectPath: "/repos/acme",
    });

    await store.setServiceProject("api", "   ");

    const raw = JSON.parse(await readFile(configPath, "utf8"));
    expect(raw.services[0]).not.toHaveProperty("projectPath");
  });

  test("setServiceProject rejects an unknown service", async () => {
    const store = new ConfigStore(configPath);

    await expect(store.setServiceProject("ghost", "/repos/acme")).rejects.toThrow(
      'Service "ghost" is not registered.',
    );
  });

  test("registers a service and persists it", async () => {
    const store = new ConfigStore(configPath);

    await store.registerService({
      name: "backend",
      command: "npm run dev",
      cwd: "/repo/backend",
      port: 3001,
      env: { API_MODE: "local" },
      description: "API server",
    });

    const config = await store.load();
    const raw = JSON.parse(await readFile(configPath, "utf8"));

    expect(config.services).toEqual([
      {
        name: "backend",
        command: "npm run dev",
        cwd: "/repo/backend",
        port: 3001,
        env: { API_MODE: "local" },
        description: "API server",
      },
    ]);
    expect(raw.services[0].name).toBe("backend");
  });

  test("removes a service and prunes it from bundles", async () => {
    const store = new ConfigStore(configPath);

    await store.registerService({ name: "db", command: "x", cwd: "/repo" });
    await store.registerService({ name: "api", command: "y", cwd: "/repo" });
    await store.registerBundle({ name: "stack", services: ["db", "api"] });

    const config = await store.removeService("db");

    expect(config.services.map((service) => service.name)).toEqual(["api"]);
    expect(config.bundles).toEqual([{ name: "stack", services: ["api"] }]);
  });

  test("removeService rejects an unknown service", async () => {
    const store = new ConfigStore(configPath);

    await expect(store.removeService("ghost")).rejects.toThrow(/not registered/);
  });

  test("registers a bundle and replaces an existing bundle with the same name", async () => {
    const store = new ConfigStore(configPath);

    await store.registerBundle({ name: "full-stack", services: ["db"] });
    await store.registerBundle({
      name: "full-stack",
      services: ["db", "backend", "frontend"],
    });

    const config = await store.load();

    expect(config.bundles).toEqual([
      {
        name: "full-stack",
        services: ["db", "backend", "frontend"],
      },
    ]);
  });

  test("registers and selects a git repository", async () => {
    const store = new ConfigStore(configPath);
    const repoPath = await makeGitRepository("app");

    await store.registerGitRepository({
      name: "app",
      path: repoPath,
    });
    await store.selectGitRepository("app");

    const config = await store.load();

    expect(config.gitRepositories).toEqual([
      {
        name: "app",
        path: repoPath,
      },
    ]);
    expect(config.selectedGitRepository).toBe("app");
  });

  test("selects a linked worktree without turning it into another project", async () => {
    const store = new ConfigStore(configPath);
    const repoPath = await makeGitRepository("app");
    const worktreePath = join(tempDir, "app-feature");
    await execFileAsync("git", ["worktree", "add", "-b", "feature/app", worktreePath], {
      cwd: repoPath,
    });
    await store.registerGitRepository({ name: "app", path: repoPath });

    const config = await store.selectGitWorktree("app", worktreePath);

    expect(config.gitRepositories).toEqual([
      {
        name: "app",
        path: repoPath,
        activeWorktreePath: await realpath(worktreePath),
      },
    ]);
  });

  test("registers a docker-compose service", async () => {
    const store = new ConfigStore(configPath);

    await store.registerService({
      name: "api",
      kind: "docker-compose",
      cwd: "/repo",
      composeFile: "docker-compose.yml",
      composeService: "api",
      port: 3001,
    });

    const config = await store.load();
    expect(config.services[0]).toMatchObject({
      name: "api",
      kind: "docker-compose",
      composeService: "api",
      composeFile: "docker-compose.yml",
      cwd: "/repo",
      port: 3001,
    });
  });

  test("registers an ssh service", async () => {
    const store = new ConfigStore(configPath);

    await store.registerService({
      name: "staging-api",
      kind: "ssh",
      host: "devbox",
      cwd: "/srv/app",
      command: "npm run dev",
      port: 3001,
    });

    const config = await store.load();
    expect(config.services[0]).toMatchObject({
      name: "staging-api",
      kind: "ssh",
      host: "devbox",
      cwd: "/srv/app",
      command: "npm run dev",
    });
  });

  test("rejects ssh services with empty host or null-byte commands", async () => {
    const store = new ConfigStore(configPath);

    await expect(
      store.registerService({
        name: "bad",
        kind: "ssh",
        host: "",
        cwd: "/srv/app",
        command: "x",
      }),
    ).rejects.toThrow();
    await expect(
      store.registerService({
        name: "bad",
        kind: "ssh",
        host: "h",
        cwd: "/srv/app",
        command: "x\0y",
      }),
    ).rejects.toThrow(/null byte/);
  });

  test("rejects git repository paths that are not absolute", async () => {
    const store = new ConfigStore(configPath);

    await expect(
      store.registerGitRepository({
        name: "app",
        path: "~/repo/app",
      }),
    ).rejects.toThrow("Please add an absolute path");
  });

  test("rejects absolute git repository paths that are not git worktrees", async () => {
    const store = new ConfigStore(configPath);
    const notGitPath = join(tempDir, "not-git");
    await mkdir(notGitPath);

    await expect(
      store.registerGitRepository({
        name: "app",
        path: notGitPath,
      }),
    ).rejects.toThrow("Not a Git repository");
  });

  test("removes a git repository and clears the selection when needed", async () => {
    const store = new ConfigStore(configPath);
    const repoPath = await makeGitRepository("app");

    await store.registerGitRepository({
      name: "app",
      path: repoPath,
    });

    const config = await store.removeGitRepository("app");

    expect(config.gitRepositories).toEqual([]);
    expect(config.selectedGitRepository).toBeUndefined();
  });

  test("stores, retrieves, and removes a GitHub token", async () => {
    const store = new ConfigStore(configPath);

    await store.setGithubToken("github.com", "ghp_abc123");
    const config = await store.load();
    expect(store.getGithubToken(config)).toBe("ghp_abc123");
    expect(store.getGithubToken(config, "github.com")).toBe("ghp_abc123");
    expect(store.getGithubToken(config, "github.enterprise.com")).toBeUndefined();
  });

  test("stores independent GitHub credential selections per repository", async () => {
    const store = new ConfigStore(configPath);
    const firstPath = await makeGitRepository("work");
    const secondPath = await makeGitRepository("personal");
    await store.registerGitRepository({ name: "work", path: firstPath });
    await store.registerGitRepository({ name: "personal", path: secondPath });

    await store.setGitHubCredential("work", {
      source: "gh",
      host: "github.com",
      login: "work-user",
    });
    await store.setGitHubCredential("personal", {
      source: "gh",
      host: "github.com",
      login: "personal-user",
    });

    const config = await store.load();
    expect(config.gitRepositories.find((repo) => repo.name === "work")?.githubCredential)
      .toEqual({ source: "gh", host: "github.com", login: "work-user" });
    expect(config.gitRepositories.find((repo) => repo.name === "personal")?.githubCredential)
      .toEqual({ source: "gh", host: "github.com", login: "personal-user" });
  });

  test("preserves a GitHub credential when re-registering a repository", async () => {
    const store = new ConfigStore(configPath);
    const repoPath = await makeGitRepository("preserved");
    await store.registerGitRepository({ name: "app", path: repoPath });
    await store.setGitHubCredential("app", {
      source: "gh",
      host: "github.com",
      login: "work-user",
    });

    await store.registerGitRepository({ name: "app", path: repoPath });

    expect((await store.load()).gitRepositories[0]?.githubCredential)
      .toEqual({ source: "gh", host: "github.com", login: "work-user" });
  });

  test("replaces an existing GitHub token for the same host", async () => {
    const store = new ConfigStore(configPath);

    await store.setGithubToken("github.com", "ghp_first");
    await store.setGithubToken("github.com", "ghp_second");
    const config = await store.load();
    expect(config.githubTokens).toHaveLength(1);
    expect(store.getGithubToken(config)).toBe("ghp_second");
  });

  test("remembers the account a GitHub token belongs to", async () => {
    const store = new ConfigStore(configPath);

    await store.setGithubToken("github.com", "ghp_abc123", {
      login: "octocat",
      avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
    });

    const config = await store.load();
    expect(store.getGithubProfile(config)).toEqual({
      login: "octocat",
      avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
    });
    // The secret is still the point of the entry.
    expect(store.getGithubToken(config)).toBe("ghp_abc123");
  });

  test("backfills an account onto a token stored without one", async () => {
    const store = new ConfigStore(configPath);

    await store.setGithubToken("github.com", "ghp_legacy");
    expect(store.getGithubProfile(await store.load())).toBeUndefined();

    await store.setGithubProfile("github.com", { login: "octocat" });

    const config = await store.load();
    expect(store.getGithubProfile(config)).toEqual({ login: "octocat", avatarUrl: undefined });
    expect(store.getGithubToken(config)).toBe("ghp_legacy");
  });

  test("removes a GitHub token without affecting other hosts", async () => {
    const store = new ConfigStore(configPath);

    await store.setGithubToken("github.com", "ghp_public");
    await store.setGithubToken("github.enterprise.com", "ghp_enterprise");
    await store.removeGithubToken("github.com");
    const config = await store.load();
    expect(store.getGithubToken(config, "github.com")).toBeUndefined();
    expect(store.getGithubToken(config, "github.enterprise.com")).toBe("ghp_enterprise");
  });
});

/**
 * Configs written before connections were keyed by provider id must keep
 * working — a user upgrading NoMoreIDE should not have to reconnect Vercel or
 * re-pin their project.
 */
describe("legacy provider config migration", () => {
  /** A config.json exactly as a pre-registry build would have written it. */
  async function writeLegacyConfig(extra: Record<string, unknown> = {}): Promise<void> {
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        services: [],
        bundles: [],
        gitRepositories: [],
        databases: [],
        logSources: [],
        sshServers: [],
        githubTokens: [],
        githubIdentities: [],
        workflows: [],
        workflowTriggers: [],
        ...extra,
      }),
    );
  }

  test("lifts a legacy vercel connection into connections.vercel", async () => {
    await writeLegacyConfig({
      vercel: { source: "stored", token: "pat_legacy", username: "acme" },
    });

    const config = await new ConfigStore(configPath).load();

    expect(config.connections.vercel).toEqual({
      source: "stored",
      token: "pat_legacy",
      username: "acme",
    });
  });

  test("renames the legacy team scope to the neutral scope fields", async () => {
    await writeLegacyConfig({
      vercel: { source: "cli", teamId: "team_abc", teamSlug: "acme" },
    });

    const config = await new ConfigStore(configPath).load();

    expect(config.connections.vercel).toMatchObject({
      source: "cli",
      scopeId: "team_abc",
      scopeSlug: "acme",
    });
    expect(config.connections.vercel).not.toHaveProperty("teamId");
  });

  test("lifts a repository's pinned vercel project into providerProjects", async () => {
    await writeLegacyConfig({
      gitRepositories: [
        { name: "web", path: "/tmp/web", vercelProjectId: "prj_legacy" },
        { name: "api", path: "/tmp/api" },
      ],
    });

    const config = await new ConfigStore(configPath).load();

    expect(config.gitRepositories[0].providerProjects).toEqual({ vercel: "prj_legacy" });
    // A repo that never pinned one stays absent rather than gaining an empty map.
    expect(config.gitRepositories[1].providerProjects).toBeUndefined();
  });

  test("drops the legacy keys on the next write", async () => {
    await writeLegacyConfig({
      vercel: { source: "stored", token: "pat_legacy", teamId: "team_abc" },
      gitRepositories: [{ name: "web", path: "/tmp/web", vercelProjectId: "prj_legacy" }],
    });
    const store = new ConfigStore(configPath);

    await store.save(await store.load());

    const raw = JSON.parse(await readFile(configPath, "utf8"));
    expect(raw).not.toHaveProperty("vercel");
    expect(raw.gitRepositories[0]).not.toHaveProperty("vercelProjectId");
    expect(raw.connections.vercel.scopeId).toBe("team_abc");
    expect(raw.gitRepositories[0].providerProjects).toEqual({ vercel: "prj_legacy" });
  });

  test("a provider-keyed value wins when both shapes are present", async () => {
    await writeLegacyConfig({
      vercel: { source: "stored", token: "pat_legacy" },
      connections: { vercel: { source: "stored", token: "pat_current" } },
    });

    const config = await new ConfigStore(configPath).load();

    expect(config.connections.vercel?.token).toBe("pat_current");
  });

  test("a config with no legacy keys is untouched", async () => {
    await writeLegacyConfig();

    const config = await new ConfigStore(configPath).load();

    expect(config.connections).toEqual({});
  });
});

describe("provider connections", () => {
  test("keeps providers independent of one another", async () => {
    const store = new ConfigStore(configPath);

    await store.setConnection("vercel", { source: "stored", token: "pat_vercel" });
    await store.setConnection("cloudflare", { source: "stored", token: "pat_cf" });
    await store.removeConnection("vercel");

    const config = await store.load();
    expect(config.connections.vercel).toBeUndefined();
    expect(config.connections.cloudflare?.token).toBe("pat_cf");
  });

  test("a cli connection never stores a token copy", async () => {
    const store = new ConfigStore(configPath);

    await store.setConnection("vercel", { source: "cli", token: "should-be-dropped" });

    expect((await store.load()).connections.vercel?.token).toBeUndefined();
  });

  test("rejects a provider id that is not filename-safe", async () => {
    const store = new ConfigStore(configPath);

    await expect(
      store.setConnection("../escape", { source: "stored", token: "t" }),
    ).rejects.toThrow();
  });

  test("unpinning the last provider project removes the key entirely", async () => {
    const store = new ConfigStore(configPath);
    const repoPath = await makeGitRepository("web");
    await store.registerGitRepository({ name: "web", path: repoPath });

    await store.setProviderProject("vercel", "web", "prj_1");
    await store.setProviderProject("vercel", "web", undefined);

    const config = await store.load();
    expect(config.gitRepositories[0].providerProjects).toBeUndefined();
  });

  test("re-registering a repository preserves its pinned provider projects", async () => {
    const store = new ConfigStore(configPath);
    const repoPath = await makeGitRepository("web");
    await store.registerGitRepository({ name: "web", path: repoPath });
    await store.setProviderProject("vercel", "web", "prj_1");

    await store.registerGitRepository({ name: "web", path: repoPath });

    const config = await store.load();
    expect(config.gitRepositories[0].providerProjects).toEqual({ vercel: "prj_1" });
  });
});

async function makeGitRepository(name: string): Promise<string> {
  const repoPath = join(tempDir, name);
  await mkdir(repoPath);
  await execFileAsync("git", ["init"], { cwd: repoPath });
  return repoPath;
}
