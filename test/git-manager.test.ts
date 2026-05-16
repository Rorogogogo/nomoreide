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
});

async function execGit(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repoDir });
  return stdout;
}
