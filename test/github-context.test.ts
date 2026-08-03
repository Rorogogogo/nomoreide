import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ConfigStore } from "../src/core/config-store.js";
import { requireGitHubContext, selectedGitHubCwd } from "../src/core/github-context.js";

const execFileAsync = promisify(execFile);
let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-github-context-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("GitHub repository credential context", () => {
  test("uses the selected repository when an MCP caller omits cwd", () => {
    expect(selectedGitHubCwd({
      version: 1,
      services: [],
      bundles: [],
      gitRepositories: [
        { name: "first", path: "/repos/first" },
        { name: "second", path: "/repos/second", activeWorktreePath: "/worktrees/second" },
      ],
      selectedGitRepository: "second",
      databases: [],
      logSources: [],
      githubTokens: [],
      workflows: [],
      workflowTriggers: [],
    }, "/fallback")).toBe("/worktrees/second");
  });

  test("fails closed for an unregistered repository nested under another project", async () => {
    const outer = join(tempDir, "outer");
    const nested = join(outer, "nested");
    await mkdir(outer);
    await initRepository(outer, "https://github.com/acme/outer.git");
    await mkdir(nested);
    await initRepository(nested, "https://github.com/acme/nested.git");
    const store = new ConfigStore(join(tempDir, "config.json"));
    await store.registerGitRepository({ name: "outer", path: outer });
    await store.setGithubToken("github.com", "legacy-token");

    await expect(requireGitHubContext(store, nested)).rejects.toThrow(
      "nested Git repository is not registered",
    );
  });

  test("matches a registered repository through a symlinked cwd", async () => {
    const repository = join(tempDir, "repository");
    const linked = join(tempDir, "linked");
    await mkdir(repository);
    await initRepository(repository, "https://github.com/acme/repository.git");
    await symlink(repository, linked);
    const store = new ConfigStore(join(tempDir, "config.json"));
    await store.registerGitRepository({
      name: "repository",
      path: repository,
      githubCredential: { source: "stored", host: "github.com" },
    });
    await store.setGithubToken("github.com", "stored-token");

    await expect(requireGitHubContext(store, linked)).resolves.toMatchObject({
      owner: "acme",
      repo: "repository",
      credential: { source: "stored", host: "github.com" },
    });
  });
});

async function initRepository(path: string, remote: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: path });
  await execFileAsync("git", ["remote", "add", "origin", remote], { cwd: path });
}
