import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ConfigStore } from "../src/core/config-store.js";

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
  test("creates a default config when the file does not exist", async () => {
    const store = new ConfigStore(configPath);

    const config = await store.load();

    expect(config).toEqual({
      version: 1,
      services: [],
      bundles: [],
      gitRepositories: [],
    });
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

    await store.registerGitRepository({
      name: "app",
      path: "/repo/app",
    });
    await store.selectGitRepository("app");

    const config = await store.load();

    expect(config.gitRepositories).toEqual([
      {
        name: "app",
        path: "/repo/app",
      },
    ]);
    expect(config.selectedGitRepository).toBe("app");
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
});
