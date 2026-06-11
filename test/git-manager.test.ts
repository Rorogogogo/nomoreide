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

  test("reports ahead/behind against upstream", async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), "nomoreide-git-remote-"));
    try {
      await execGit(["checkout", "-b", "main"]);
      await execFileAsync("git", ["init", "--bare"], { cwd: remoteDir });
      await execGit(["remote", "add", "origin", remoteDir]);
      await execGit(["push", "-u", "origin", "main"]);

      // In sync with upstream right after pushing.
      let status = await git.status();
      expect(status.upstream).toBe("origin/main");
      expect(status).toMatchObject({ ahead: 0, behind: 0 });

      // Two local commits the remote hasn't seen → ahead by 2.
      await writeFile(join(repoDir, "ahead-1.txt"), "1\n");
      await execGit(["add", "ahead-1.txt"]);
      await execGit(["commit", "-m", "ahead 1"]);
      await writeFile(join(repoDir, "ahead-2.txt"), "2\n");
      await execGit(["add", "ahead-2.txt"]);
      await execGit(["commit", "-m", "ahead 2"]);

      status = await git.status();
      expect(status).toMatchObject({ ahead: 2, behind: 0 });
    } finally {
      await rm(remoteDir, { recursive: true, force: true });
    }
  });

  test("reports zero ahead/behind with no upstream", async () => {
    const status = await git.status();
    expect(status.upstream).toBeUndefined();
    expect(status).toMatchObject({ ahead: 0, behind: 0 });
  });

  test("compares the current branch against a local base ref", async () => {
    await execGit(["checkout", "-b", "main"]);
    await execGit(["checkout", "-b", "feature/pr-assistant"]);
    await writeFile(join(repoDir, "assistant.txt"), "draft\n");
    await execGit(["add", "assistant.txt"]);
    await execGit(["commit", "-m", "Add PR assistant"]);
    await writeFile(join(repoDir, "README.md"), "updated\n");
    await execGit(["add", "README.md"]);
    await execGit(["commit", "-m", "Update README"]);

    const compare = await git.compareWithBase("main");

    expect(compare.aheadBy).toBe(2);
    expect(compare.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(compare.commits.map((commit) => commit.message)).toEqual([
      "Add PR assistant",
      "Update README",
    ]);
    expect(compare.files.map((file) => file.path).sort()).toEqual([
      "README.md",
      "assistant.txt",
    ]);
  });

  test("creates and switches branches", async () => {
    await git.createBranch("feature/work");

    expect((await git.status()).branch).toBe("feature/work");

    await git.switchBranch("master");

    expect((await git.status()).branch).toBe("master");
  });

  test("commitFiles parses -z output for add/modify/delete and rename", async () => {
    // commit 1: add two files, modify README
    await writeFile(join(repoDir, "README.md"), "modified\n");
    await writeFile(join(repoDir, "a.txt"), "a\n");
    await writeFile(join(repoDir, "b.txt"), "b\n");
    await execGit(["add", "."]);
    await execGit(["commit", "-m", "multi-change commit"]);

    const head = (await execGit(["rev-parse", "HEAD"])).trim();
    const files = await git.commitFiles(head);
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(["README.md", "a.txt", "b.txt"]);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f.index]));
    expect(byPath["README.md"]).toBe("M");
    expect(byPath["a.txt"]).toBe("A");
    expect(byPath["b.txt"]).toBe("A");

    // commit 2: rename a.txt -> renamed.txt
    await execGit(["mv", "a.txt", "renamed.txt"]);
    await execGit(["commit", "-m", "rename"]);
    const renameHead = (await execGit(["rev-parse", "HEAD"])).trim();
    const renameFiles = await git.commitFiles(renameHead);
    expect(renameFiles).toHaveLength(1);
    expect(renameFiles[0].path).toBe("renamed.txt");
    expect(renameFiles[0].index).toBe("R");
  });

  test("commitDiff returns patch text including root commits", async () => {
    await writeFile(join(repoDir, "feature.txt"), "added\n");
    await execGit(["add", "feature.txt"]);
    await execGit(["commit", "-m", "add feature"]);

    const headHash = (await execGit(["rev-parse", "HEAD"])).trim();
    const rootHash = (await execGit(["rev-list", "--max-parents=0", "HEAD"])).trim();

    const headDiff = await git.commitDiff(headHash);
    expect(headDiff).toContain("+++ b/feature.txt");
    expect(headDiff).toContain("+added");

    const rootDiff = await git.commitDiff(rootHash);
    expect(rootDiff).toContain("README.md");

    await expect(git.commitDiff("not-a-hash!!")).rejects.toThrow(/invalid commit hash/);
  });

  test("listTrackedFiles returns paths from git ls-files", async () => {
    const { mkdir } = await import("node:fs/promises");
    await writeFile(join(repoDir, "a.txt"), "a\n");
    await mkdir(join(repoDir, "nested"), { recursive: true });
    await writeFile(join(repoDir, "nested/b.txt"), "b\n");
    await execGit(["add", "a.txt", "nested/b.txt"]);
    await execGit(["commit", "-m", "add files"]);

    const files = await git.listTrackedFiles();
    expect(files.sort()).toEqual(["README.md", "a.txt", "nested/b.txt"]);
  });

  test("readTrackedFile returns content for tracked files", async () => {
    const content = await git.readTrackedFile("README.md");
    expect(content.content).toBe("initial\n");
    expect(content.binary).toBe(false);
    expect(content.truncated).toBe(false);
  });

  test("writeTrackedFile updates tracked text files", async () => {
    await git.writeTrackedFile("README.md", "changed from web\n");

    await expect(readFile(join(repoDir, "README.md"), "utf8")).resolves.toBe(
      "changed from web\n",
    );
    expect(await git.diff("README.md")).toContain("+changed from web");
  });

  test("writeTrackedFile rejects untracked paths", async () => {
    await writeFile(join(repoDir, "untracked.txt"), "hello\n");

    await expect(git.writeTrackedFile("untracked.txt", "changed\n")).rejects.toThrow(
      /not tracked/,
    );
  });

  test("writeTrackedFile rejects path traversal", async () => {
    await expect(git.writeTrackedFile("../escape", "changed\n")).rejects.toThrow();
  });

  test("rankFilesBySize orders tracked files by line count, longest first", async () => {
    await writeFile(join(repoDir, "long.ts"), "x\n".repeat(40));
    await writeFile(join(repoDir, "short.ts"), "y\n".repeat(3));
    await execGit(["add", "long.ts", "short.ts"]);
    await execGit(["commit", "-m", "add ranked files"]);

    const ranked = await git.rankFilesBySize();
    const paths = ranked.map((file) => file.path);
    expect(paths.indexOf("long.ts")).toBeLessThan(paths.indexOf("short.ts"));
    expect(ranked.find((file) => file.path === "long.ts")?.lines).toBe(40);
  });

  test("rankFilesBySize skips binary files", async () => {
    await writeFile(join(repoDir, "blob.bin"), Buffer.from([0, 1, 2, 0, 3]));
    await execGit(["add", "blob.bin"]);
    await execGit(["commit", "-m", "add binary"]);

    const ranked = await git.rankFilesBySize();
    expect(ranked.some((file) => file.path === "blob.bin")).toBe(false);
  });

  test("readTrackedFile rejects untracked paths", async () => {
    await writeFile(join(repoDir, "untracked.txt"), "hello\n");
    await expect(git.readTrackedFile("untracked.txt")).rejects.toThrow(/not tracked/);
  });

  test("readTrackedFile rejects path traversal", async () => {
    await expect(git.readTrackedFile("../escape")).rejects.toThrow();
  });

  test("graph returns ordered commits with refs, parents, and lanes", async () => {
    // master: initial -> M (second on master)
    //                  \-> side commit C -> merged via M
    await writeFile(join(repoDir, "main.txt"), "main\n");
    await execGit(["add", "main.txt"]);
    await execGit(["commit", "-m", "main work"]);

    await execGit(["checkout", "-b", "side", "HEAD~1"]);
    await writeFile(join(repoDir, "side.txt"), "side\n");
    await execGit(["add", "side.txt"]);
    await execGit(["commit", "-m", "side work"]);

    await execGit(["checkout", "master"]);
    await execGit(["merge", "--no-ff", "side", "-m", "merge side"]);
    await execGit(["tag", "v0.1"]);

    const graph = await git.graph(50);

    expect(graph.length).toBeGreaterThanOrEqual(4);
    const subjects = graph.map((c) => c.subject);
    expect(subjects).toContain("merge side");
    expect(subjects).toContain("side work");
    expect(subjects).toContain("main work");
    expect(subjects).toContain("initial commit");

    const merge = graph.find((c) => c.subject === "merge side")!;
    expect(merge.parents).toHaveLength(2);
    expect(merge.edges).toHaveLength(2);

    const head = graph[0];
    expect(head.refs.some((r) => r.kind === "head" && r.name === "HEAD")).toBe(true);
    expect(head.refs.some((r) => r.kind === "branch" && r.name === "master")).toBe(true);

    const tagged = graph.find((c) => c.refs.some((r) => r.kind === "tag" && r.name === "v0.1"));
    expect(tagged).toBeDefined();
  });
});

async function execGit(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repoDir });
  return stdout;
}
