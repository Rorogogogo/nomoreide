import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  AgentSessionStore,
  createAgentSessionTracker,
} from "../src/core/agent-sessions.js";
import { ConfigStore } from "../src/core/config-store.js";
import { SnapshotManager } from "../src/core/snapshot-manager.js";

const execFileAsync = promisify(execFile);

let repoDir: string;

async function execGit(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repoDir });
  return stdout;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "nomoreide-snapshot-"));
  await execGit(["init"]);
  await execGit(["config", "user.email", "nomoreide@example.test"]);
  await execGit(["config", "user.name", "NoMoreIDE Test"]);
  await execGit(["checkout", "-b", "main"]);
  await writeFile(join(repoDir, "README.md"), "initial\n");
  await execGit(["add", "README.md"]);
  await execGit(["commit", "-m", "initial commit"]);
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe("SnapshotManager.snapshot", () => {
  test("captures the working tree without moving HEAD, branches, or the index", async () => {
    await writeFile(join(repoDir, "staged.txt"), "staged\n");
    await execGit(["add", "staged.txt"]);
    await writeFile(join(repoDir, "untracked.txt"), "untracked\n");
    const headBefore = (await execGit(["rev-parse", "HEAD"])).trim();
    const indexBefore = await execGit(["status", "--porcelain=v1"]);

    const manager = new SnapshotManager(repoDir);
    const snapshot = await manager.snapshot("before risky change");

    expect((await execGit(["rev-parse", "HEAD"])).trim()).toBe(headBefore);
    expect(await execGit(["status", "--porcelain=v1"])).toBe(indexBefore);
    expect(snapshot.ref.startsWith("refs/nomoreide/snapshots/")).toBe(true);
    // The snapshot tree contains the untracked file even though the user
    // never staged it.
    const tree = await execGit(["ls-tree", "--name-only", snapshot.sha]);
    expect(tree).toContain("untracked.txt");
    expect(tree).toContain("staged.txt");
  });

  test("list returns newest first with labels", async () => {
    const manager = new SnapshotManager(repoDir);
    const first = await manager.snapshot("first");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await manager.snapshot("second");

    const snapshots = await manager.list();
    expect(snapshots.map((entry) => entry.sha)).toEqual([second.sha, first.sha]);
    expect(snapshots[0].label).toBe("second");
  });
});

describe("SnapshotManager.changedFiles", () => {
  test("reports adds, modifications, and deletions vs the working tree", async () => {
    const manager = new SnapshotManager(repoDir);
    const snapshot = await manager.snapshot("baseline");

    await writeFile(join(repoDir, "README.md"), "modified\n");
    await writeFile(join(repoDir, "new-file.txt"), "new\n");

    const changes = await manager.changedFiles(snapshot.sha);
    const byPath = Object.fromEntries(changes.map((change) => [change.path, change.status]));
    expect(byPath["README.md"]).toBe("M");
    expect(byPath["new-file.txt"]).toBe("A");
  });
});

describe("SnapshotManager.restore", () => {
  test("restores content, removes files added since, and is reversible", async () => {
    const manager = new SnapshotManager(repoDir);
    const snapshot = await manager.snapshot("baseline");

    await writeFile(join(repoDir, "README.md"), "agent broke this\n");
    await writeFile(join(repoDir, "agent-junk.txt"), "junk\n");
    await rm(join(repoDir, "README.md"));
    await writeFile(join(repoDir, "README.md"), "agent broke this\n");

    const result = await manager.restore(snapshot.sha);

    expect(await readFile(join(repoDir, "README.md"), "utf8")).toBe("initial\n");
    expect(await fileExists(join(repoDir, "agent-junk.txt"))).toBe(false);
    expect(result.deletedPaths).toContain("agent-junk.txt");
    expect(result.restoredFiles).toBeGreaterThan(0);

    // The restore is itself undoable: the pre-restore snapshot holds the
    // broken state.
    const undo = await manager.restore(result.preRestore.sha);
    expect(await readFile(join(repoDir, "README.md"), "utf8")).toBe(
      "agent broke this\n",
    );
    expect(await readFile(join(repoDir, "agent-junk.txt"), "utf8")).toBe("junk\n");
    expect(undo.preRestore.sha).not.toBe(result.preRestore.sha);
  });

  test("refuses shas outside the snapshot namespace", async () => {
    const manager = new SnapshotManager(repoDir);
    await manager.snapshot("baseline");
    const head = (await execGit(["rev-parse", "HEAD"])).trim();

    await expect(manager.restore(head)).rejects.toThrow(/Not a nomoreide snapshot/);
  });
});

describe("SnapshotManager.prune", () => {
  test("keeps only the newest N snapshots", async () => {
    const manager = new SnapshotManager(repoDir);
    for (let index = 0; index < 5; index += 1) {
      await manager.snapshot(`snap ${index}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    const removed = await manager.prune(2);
    expect(removed).toBe(3);
    const remaining = await manager.list();
    expect(remaining).toHaveLength(2);
    expect(remaining[0].label).toBe("snap 4");
  });
});

describe("agent session tracker", () => {
  test("starts one session per idle window, snapshots once, and persists", async () => {
    const storePath = join(repoDir, ".nomoreide", "agent-sessions.json");
    const store = new AgentSessionStore(storePath);
    const configStore = new ConfigStore(join(repoDir, "config.json"));
    let clock = 1_000_000;
    const tracker = createAgentSessionTracker({
      store,
      configStore,
      cwd: repoDir,
      idleMs: 1_000,
      now: () => clock,
    });

    const firstId = await tracker.beforeToolCall();
    clock += 100;
    const secondId = await tracker.beforeToolCall();
    expect(secondId).toBe(firstId);

    clock += 10_000; // past the idle window → new session
    const thirdId = await tracker.beforeToolCall();
    expect(thirdId).not.toBe(firstId);

    const sessions = await store.list();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe(thirdId);
    expect(sessions[1].toolCount).toBe(2);
    expect(sessions[1].snapshotSha).toMatch(/^[0-9a-f]{40}$/);

    // One snapshot per session, not per tool call.
    const snapshots = await new SnapshotManager(repoDir).list();
    expect(snapshots).toHaveLength(2);
  });

  test("survives a non-git directory without blocking tool calls", async () => {
    const plainDir = await mkdtemp(join(tmpdir(), "nomoreide-plain-"));
    try {
      const store = new AgentSessionStore(join(plainDir, "sessions.json"));
      const configStore = new ConfigStore(join(plainDir, "config.json"));
      const tracker = createAgentSessionTracker({
        store,
        configStore,
        cwd: plainDir,
      });

      const id = await tracker.beforeToolCall();
      expect(id).toBeTruthy();
      const sessions = await store.list();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].snapshotSha).toBeUndefined();
    } finally {
      await rm(plainDir, { recursive: true, force: true });
    }
  });
});
