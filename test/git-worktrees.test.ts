import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  GitWorktreeManager,
  parseGitWorktreePorcelain,
} from "../src/core/git-worktrees.js";

const execFileAsync = promisify(execFile);

describe("Git worktrees", () => {
  let root: string;
  let repo: string;
  let managedRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "nomoreide-worktrees-"));
    repo = join(root, "repo");
    managedRoot = join(root, "managed");
    await execFileAsync("git", ["init", repo]);
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: repo });
    await writeFile(join(repo, "README.md"), "main\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: repo });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repo });
  });

  afterEach(async () => {
    await execFileAsync("git", ["worktree", "prune"], { cwd: repo }).catch(() => undefined);
  });

  test("parses porcelain records and optional states", () => {
    const parsed = parseGitWorktreePorcelain(
      [
        "worktree /repo",
        "HEAD abc123",
        "branch refs/heads/main",
        "",
        "worktree /repo-task",
        "HEAD def456",
        "detached",
        "locked in use",
        "prunable gitdir file points to non-existent location",
        "",
      ].join("\0"),
    );

    expect(parsed).toEqual([
      expect.objectContaining({ path: "/repo", branch: "main", detached: false }),
      expect.objectContaining({
        path: "/repo-task",
        detached: true,
        locked: true,
        lockedReason: "in use",
        prunable: true,
      }),
    ]);
  });

  test("creates and lists a managed worktree on a new branch", async () => {
    const manager = new GitWorktreeManager(repo, managedRoot);
    const created = await manager.create({
      branch: "feature/worktrees",
      createBranch: true,
      projectName: "demo",
    });

    expect(created.branch).toBe("feature/worktrees");
    expect(created.path).toBe(
      await realpath(join(managedRoot, "demo", "feature-worktrees")),
    );
    expect(created.primary).toBe(false);
    expect(created.createdAt).toEqual(expect.any(Number));
    expect(await readFile(join(created.path, "README.md"), "utf8")).toBe("main\n");

    const worktrees = await manager.list();
    expect(worktrees).toHaveLength(2);
    expect(worktrees[0]).toMatchObject({ path: await realpath(repo), primary: true });
  });

  test("refuses to remove the primary or a dirty linked worktree", async () => {
    const manager = new GitWorktreeManager(repo, managedRoot);
    const created = await manager.create({
      branch: "feature/dirty",
      createBranch: true,
    });
    await writeFile(join(created.path, "dirty.txt"), "change\n");

    await expect(manager.remove(repo)).rejects.toThrow("primary worktree");
    await expect(manager.remove(created.path)).rejects.toThrow("Commit, stash, or discard");
  });

  test("removes a clean linked worktree without forcing", async () => {
    const manager = new GitWorktreeManager(repo, managedRoot);
    const created = await manager.create({
      branch: "feature/clean",
      createBranch: true,
    });

    await manager.remove(created.path);

    expect(await manager.list()).toEqual([
      expect.objectContaining({ path: await realpath(repo), primary: true }),
    ]);
  });
});
