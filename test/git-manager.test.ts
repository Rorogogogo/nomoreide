import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GitManager } from "../src/core/git-manager.js";

const execFileAsync = promisify(execFile);

let repoDir: string;
let git: GitManager;

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "nomoreide-git-"));
  await execGit(["init"]);
  await execGit(["config", "user.email", "nomoreide@example.test"]);
  await execGit(["config", "user.name", "NoMoreIDE Test"]);
  await writeFile(join(repoDir, "README.md"), "initial\n");
  await execGit(["add", "README.md"]);
  await execGit(["commit", "-m", "initial commit"]);
  git = new GitManager(repoDir);
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe("GitManager", () => {
  test("returns branch and porcelain status", async () => {
    await writeFile(join(repoDir, "feature.txt"), "hello\n");

    const status = await git.status();

    expect(status.branch).toBeTruthy();
    expect(status.files).toEqual([
      {
        path: "feature.txt",
        index: "?",
        workingTree: "?",
      },
    ]);
  });

  test("returns diff text for changed files", async () => {
    await writeFile(join(repoDir, "README.md"), "changed\n");

    const diff = await git.diff();

    expect(diff).toContain("-initial");
    expect(diff).toContain("+changed");
  });

  test("returns a new-file diff for untracked files", async () => {
    await writeFile(join(repoDir, "feature.txt"), "hello\nworld\n");

    const diff = await git.fileDiff({
      path: "feature.txt",
      index: "?",
      workingTree: "?",
    });

    expect(diff).toContain("new file mode");
    expect(diff).toContain("--- /dev/null");
    expect(diff).toContain("+++ b/feature.txt");
    expect(diff).toContain("+hello");
    expect(diff).toContain("+world");
  });

  test("returns staged diff when a file only has index changes", async () => {
    await writeFile(join(repoDir, "README.md"), "staged\n");
    await git.stage(["README.md"]);

    const diff = await git.fileDiff({
      path: "README.md",
      index: "M",
      workingTree: " ",
    });

    expect(diff).toContain("-initial");
    expect(diff).toContain("+staged");
  });

  test("stages, unstages, and commits explicit files", async () => {
    await writeFile(join(repoDir, "feature.txt"), "hello\n");

    await git.stage(["feature.txt"]);
    expect((await git.status()).files[0]).toMatchObject({
      path: "feature.txt",
      index: "A",
      workingTree: " ",
    });

    await git.unstage(["feature.txt"]);
    expect((await git.status()).files[0]).toMatchObject({
      path: "feature.txt",
      index: "?",
      workingTree: "?",
    });

    await git.stage(["feature.txt"]);
    const commit = await git.commit("add feature");
    const log = await git.log(1);

    expect(commit).toContain("add feature");
    expect(log[0]?.subject).toBe("add feature");
  });

  test("lists local and remote branches", async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), "nomoreide-git-remote-"));
    try {
      await execGit(["checkout", "-b", "feature/local"]);
      await execGit(["checkout", "-b", "main"]);
      await execFileAsync("git", ["init", "--bare"], { cwd: remoteDir });
      await execGit(["remote", "add", "origin", remoteDir]);
      await execGit(["push", "-u", "origin", "main"]);
      await execGit(["push", "origin", "feature/local:feature/remote"]);
      await execGit(["fetch", "--prune"]);

      const branches = await git.branches();

      expect(branches).toContainEqual({
        name: "main",
        current: true,
        remote: false,
        upstream: "origin/main",
      });
      expect(branches).toContainEqual({
        name: "origin/feature/remote",
        current: false,
        remote: true,
        upstream: undefined,
      });
    } finally {
      await rm(remoteDir, { recursive: true, force: true });
    }
  });

  test("creates and switches branches", async () => {
    await git.createBranch("feature/work");

    expect((await git.status()).branch).toBe("feature/work");

    await git.switchBranch("master");

    expect((await git.status()).branch).toBe("master");
  });
});

async function execGit(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repoDir });
  return stdout;
}
