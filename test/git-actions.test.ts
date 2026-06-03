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

async function execGit(args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: repoDir });
}
