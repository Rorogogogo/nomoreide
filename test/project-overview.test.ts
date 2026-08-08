import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ConfigStore } from "../src/core/config-store.js";
import { buildProjectOverview } from "../src/core/project-overview.js";

const execFileAsync = promisify(execFile);

let tempDir: string;
let configPath: string;
let configStore: ConfigStore;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-overview-"));
  configPath = join(tempDir, "nomoreide.config.json");
  configStore = new ConfigStore(configPath);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** A real git worktree, since the git summary shells out to git itself. */
async function makeRepo(
  name: string,
  opts: { remote?: string; dirtyFiles?: number } = {},
): Promise<string> {
  const path = join(tempDir, name);
  await mkdir(path, { recursive: true });
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: path });
  // Background maintenance can race the fixture teardown; disable it (see ROR-83).
  await execFileAsync("git", ["config", "maintenance.auto", "false"], { cwd: path });
  if (opts.remote) {
    await execFileAsync("git", ["remote", "add", "origin", opts.remote], { cwd: path });
  }
  for (let index = 0; index < (opts.dirtyFiles ?? 0); index += 1) {
    await writeFile(join(path, `file-${index}.txt`), "x");
  }
  await configStore.registerGitRepository({ name, path });
  return path;
}

describe("buildProjectOverview", () => {
  test("summarizes every registered project without changing which one is selected", async () => {
    await makeRepo("alpha", { dirtyFiles: 3 });
    await makeRepo("beta");
    await configStore.selectGitRepository("beta");

    const projects = await buildProjectOverview(configStore, "git");

    expect(projects.map((project) => project.name)).toEqual(["alpha", "beta"]);
    expect(projects[0]?.git).toMatchObject({ branch: "main", dirty: 3, ahead: 0, behind: 0 });
    expect(projects[1]?.git?.dirty).toBe(0);
    // The whole point of the module: looking must not move the selection the
    // rest of the app reads.
    expect((await configStore.load()).selectedGitRepository).toBe("beta");
  });

  test("keeps config order, so the grid does not reshuffle between reads", async () => {
    await makeRepo("zulu");
    await makeRepo("alpha");
    await makeRepo("mike");

    const projects = await buildProjectOverview(configStore, "git");

    expect(projects.map((project) => project.name)).toEqual(["zulu", "alpha", "mike"]);
  });

  test("carries a per-project failure on that project's row, leaving the rest intact", async () => {
    await makeRepo("has-remote", { remote: "git@github.com:acme/web.git" });
    await makeRepo("no-remote");
    await configStore.setGithubToken("github.com", "test-token", { login: "octocat" });

    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/repos/acme/web/pulls") {
        return new Response(JSON.stringify([{ number: 1 }, { number: 2 }]), { status: 200 });
      }
      // Repo info fails, so CI is unknown — the PR count must still land.
      return new Response("{}", { status: 404 });
    });

    const projects = await buildProjectOverview(configStore, "github");

    expect(projects[0]?.github).toMatchObject({
      owner: "acme",
      repo: "web",
      openPullRequests: 2,
    });
    expect(projects[0]?.github?.checks).toBeUndefined();
    // The repo with no remote fails, and says so on its own card.
    expect(projects[1]?.github).toBeUndefined();
    expect(projects[1]?.error).toMatch(/No GitHub repository resolves/);
  });

  test("returns an empty list when nothing is registered", async () => {
    expect(await buildProjectOverview(configStore, "vercel")).toEqual([]);
  });
});

describe("GET /api/overview/:domain", () => {
  test("serves a domain's rows and refuses an unknown domain", async () => {
    await makeRepo("alpha", { dirtyFiles: 1 });
    const { createWebServer } = await import("../src/web/server.js");
    const server = await createWebServer({
      configPath,
      settingsPath: join(tempDir, "settings.json"),
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    try {
      const body = await (await fetch(`${server.url}/api/overview/git`)).json();
      expect(body.ok).toBe(true);
      expect(body.projects[0]).toMatchObject({ name: "alpha", git: { dirty: 1 } });

      const unknown = await fetch(`${server.url}/api/overview/database`);
      expect(unknown.status).toBe(404);

      // Read-only by construction: nothing here answers a write.
      const written = await fetch(`${server.url}/api/overview/git`, { method: "POST" });
      expect(written.status).toBe(405);
    } finally {
      await server.stop();
    }
  });
});
