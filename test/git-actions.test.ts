import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GitActions } from "../src/core/git-actions.js";
import { GitManager } from "../src/core/git-manager.js";

const execFileAsync = promisify(execFile);

let repoDir: string;
let remoteDir: string;

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "nomoreide-actions-"));
  remoteDir = await mkdtemp(join(tmpdir(), "nomoreide-actions-remote-"));
  await execGit(["init"]);
  await execGit(["config", "user.email", "nomoreide@example.test"]);
  await execGit(["config", "user.name", "NoMoreIDE Test"]);
  await execGit(["checkout", "-b", "main"]);
  await writeFile(join(repoDir, "README.md"), "initial\n");
  await execGit(["add", "README.md"]);
  await execGit(["commit", "-m", "initial commit"]);
  await execFileAsync("git", ["init", "--bare"], { cwd: remoteDir });
  await execGit(["remote", "add", "origin", remoteDir]);
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
  await rm(remoteDir, { recursive: true, force: true });
});

describe("GitActions.push", () => {
  test("sets upstream on first push and reports it", async () => {
    const result = await new GitActions(repoDir).push();

    expect(result.branch).toBe("main");
    expect(result.setUpstream).toBe(true);

    // Upstream now tracked, branch in sync.
    const status = await new GitManager(repoDir).status();
    expect(status.upstream).toBe("origin/main");
    expect(status).toMatchObject({ ahead: 0, behind: 0 });
  });

  test("pushes subsequent commits without re-setting upstream", async () => {
    const actions = new GitActions(repoDir);
    await actions.push();

    await writeFile(join(repoDir, "next.txt"), "next\n");
    await execGit(["add", "next.txt"]);
    await execGit(["commit", "-m", "next"]);

    const result = await actions.push();
    expect(result.setUpstream).toBe(false);
    expect((await new GitManager(repoDir).status()).ahead).toBe(0);
  });
});

describe("GitActions.checkoutDefaultAndPull", () => {
  test("switches back to the default branch and fast-forwards it", async () => {
    const actions = new GitActions(repoDir);
    await actions.push();
    await execGit(["checkout", "-b", "feature/work"]);

    const result = await actions.checkoutDefaultAndPull();

    expect(result.branch).toBe("main");
    expect((await new GitManager(repoDir).status()).branch).toBe("main");
    expect(result.output).toContain("main");
  });
});

describe("GitActions branch integration", () => {
  test("pulls the current branch with fast-forward-only semantics", async () => {
    const actions = new GitActions(repoDir);
    await actions.push();

    const output = await actions.pull();

    expect(output).toMatch(/Already up.to.date|up to date/i);
  });

  test("merges another branch into the current branch", async () => {
    await execGit(["checkout", "-b", "feature/merge-me"]);
    await writeFile(join(repoDir, "merged.txt"), "merged\n");
    await execGit(["add", "merged.txt"]);
    await execGit(["commit", "-m", "merge me"]);
    await execGit(["checkout", "main"]);

    await new GitActions(repoDir).merge("feature/merge-me");

    expect((await execGitOutput(["log", "-1", "--format=%s"])).trim()).toBe("merge me");
  });

  test("rebases the current branch onto another branch", async () => {
    await execGit(["checkout", "-b", "feature/base"]);
    await writeFile(join(repoDir, "base.txt"), "base\n");
    await execGit(["add", "base.txt"]);
    await execGit(["commit", "-m", "base change"]);
    const baseHead = (await execGitOutput(["rev-parse", "HEAD"])).trim();
    await execGit(["checkout", "main"]);
    await execGit(["checkout", "-b", "feature/topic"]);
    await writeFile(join(repoDir, "topic.txt"), "topic\n");
    await execGit(["add", "topic.txt"]);
    await execGit(["commit", "-m", "topic change"]);

    await new GitActions(repoDir).rebase("feature/base");

    expect((await execGitOutput(["merge-base", "HEAD", "feature/base"])).trim()).toBe(baseHead);
    expect((await new GitManager(repoDir).status()).branch).toBe("feature/topic");
  });

  test("rejects merge and rebase when local changes are present", async () => {
    await execGit(["checkout", "-b", "feature/other"]);
    await execGit(["checkout", "main"]);
    await writeFile(join(repoDir, "dirty.txt"), "dirty\n");
    const actions = new GitActions(repoDir);

    await expect(actions.merge("feature/other")).rejects.toThrow(
      "Commit or stash local changes before merge.",
    );
    await expect(actions.rebase("feature/other")).rejects.toThrow(
      "Commit or stash local changes before rebase.",
    );
  });

  test("aborts a conflicting rebase instead of leaving it in progress", async () => {
    await execGit(["checkout", "-b", "feature/base"]);
    await writeFile(join(repoDir, "README.md"), "base\n");
    await execGit(["add", "README.md"]);
    await execGit(["commit", "-m", "base README"]);
    await execGit(["checkout", "main"]);
    await execGit(["checkout", "-b", "feature/topic"]);
    await writeFile(join(repoDir, "README.md"), "topic\n");
    await execGit(["add", "README.md"]);
    await execGit(["commit", "-m", "topic README"]);

    await expect(new GitActions(repoDir).rebase("feature/base")).rejects.toThrow(
      "Rebase failed and was aborted.",
    );

    expect((await new GitManager(repoDir).status()).branch).toBe("feature/topic");
    expect((await execGitOutput(["status", "--porcelain"])).trim()).toBe("");
  });
});

async function execGit(args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: repoDir });
}

async function execGitOutput(args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd: repoDir })).stdout;
}
