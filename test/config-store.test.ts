import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
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
      githubTokens: [],
      workflows: [],
      workflowTriggers: [],
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

  test("replaces an existing GitHub token for the same host", async () => {
    const store = new ConfigStore(configPath);

    await store.setGithubToken("github.com", "ghp_first");
    await store.setGithubToken("github.com", "ghp_second");
    const config = await store.load();
    expect(config.githubTokens).toHaveLength(1);
    expect(store.getGithubToken(config)).toBe("ghp_second");
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

async function makeGitRepository(name: string): Promise<string> {
  const repoPath = join(tempDir, name);
  await mkdir(repoPath);
  await execFileAsync("git", ["init"], { cwd: repoPath });
  return repoPath;
}
