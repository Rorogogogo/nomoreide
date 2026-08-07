import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { credentialConfigArgs, GitActions, redact } from "../src/core/git-actions.js";
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
  // maxRetries makes fs.rm retry ENOTEMPTY/EBUSY rather than throwing the
  // first time a stray git process touches the tree mid-delete. test/setup.ts
  // disables git's background maintenance, which is the cause; this is the
  // backstop for anything else that outlives a command.
  const options = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 };
  await rm(repoDir, options);
  await rm(remoteDir, options);
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

describe("push credentials", () => {
  test("the helper supplies the passed token and overrides inherited helpers", async () => {
    // A machine-level helper that would otherwise answer first — the reset in
    // credentialConfigArgs() must stop it winning and pushing as the wrong account.
    await execGit([
      "config",
      "credential.helper",
      '!f() { echo "username=machine-account"; echo "password=machine-token"; }; f',
    ]);

    const { stdout } = spawnSync("git", [...credentialConfigArgs(), "credential", "fill"], {
      cwd: repoDir,
      encoding: "utf8",
      input: "protocol=https\nhost=github.com\n\n",
      env: {
        ...process.env,
        NOMOREIDE_GIT_USERNAME: "x-access-token",
        NOMOREIDE_GIT_PASSWORD: "selected-account-token",
      },
    });

    expect(stdout).toContain("username=x-access-token");
    expect(stdout).toContain("password=selected-account-token");
    expect(stdout).not.toContain("machine-token");
  });

  test("redacts the token from anything surfaced to the UI", () => {
    expect(redact("remote: rejected using tok-123 twice: tok-123", "tok-123")).toBe(
      "remote: rejected using *** twice: ***",
    );
    expect(redact("no secret here", undefined)).toBe("no secret here");
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
