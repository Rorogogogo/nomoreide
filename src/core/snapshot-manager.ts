import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SNAPSHOT_REF_PREFIX = "refs/nomoreide/snapshots/";

/** Snapshots are anonymous safety commits; never attributed to the user. */
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "nomoreide",
  GIT_AUTHOR_EMAIL: "nomoreide@localhost",
  GIT_COMMITTER_NAME: "nomoreide",
  GIT_COMMITTER_EMAIL: "nomoreide@localhost",
};

export interface Snapshot {
  sha: string;
  ref: string;
  label: string;
  createdAt: string;
}

export interface SnapshotChange {
  /** A (added since snapshot), M (modified), D (deleted since snapshot). */
  status: string;
  path: string;
}

export interface RestoreResult {
  /** Safety snapshot taken automatically before the restore. */
  preRestore: Snapshot;
  /** Files whose content was restored or re-created from the snapshot. */
  restoredFiles: number;
  /** Files created after the snapshot that the restore removed. */
  deletedPaths: string[];
}

/**
 * Working-tree checkpoints under `refs/nomoreide/snapshots/*`, kept
 * deliberately separate from the read-safe {@link GitManager} (like
 * {@link GitActions}). Snapshots are commit objects in a private ref
 * namespace: they never move HEAD, branches, or the user's index — the tree
 * is built through a temporary `GIT_INDEX_FILE` so staged state survives.
 *
 * `restore` is the one destructive operation and it is made reversible by
 * always taking a `pre-restore` snapshot first; it also refuses shas that are
 * not in the snapshot namespace, so the API can never check out arbitrary
 * commits.
 */
export class SnapshotManager {
  constructor(private readonly cwd = process.cwd()) {}

  async snapshot(label: string): Promise<Snapshot> {
    const cleaned = label.trim() || "snapshot";
    const tree = await this.captureTree();
    const head = await this.headSha();
    const commitArgs = ["commit-tree", tree, "-m", cleaned];
    if (head) commitArgs.push("-p", head);
    const sha = (await this.git(commitArgs, SNAPSHOT_IDENTITY)).trim();
    const ref = `${SNAPSHOT_REF_PREFIX}${Date.now()}-${slugify(cleaned)}`;
    await this.git(["update-ref", ref, sha]);
    return { sha, ref, label: cleaned, createdAt: new Date().toISOString() };
  }

  /** Newest first (ref names start with the creation epoch-millis). */
  async list(): Promise<Snapshot[]> {
    const output = await this.git([
      "for-each-ref",
      "--sort=-refname",
      "--format=%(refname)%09%(objectname)%09%(creatordate:iso-strict)%09%(subject)",
      SNAPSHOT_REF_PREFIX.replace(/\/$/, ""),
    ]);
    return output
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const [ref, sha, createdAt, ...subject] = line.split("\t");
        return { ref, sha, createdAt, label: subject.join("\t") };
      });
  }

  /** Diff a snapshot against the current working tree (incl. untracked files). */
  async changedFiles(sha: string): Promise<SnapshotChange[]> {
    const tree = await this.captureTree();
    const output = await this.git([
      "diff",
      "--no-renames",
      "--name-status",
      sha,
      tree,
    ]);
    return output
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const [status, ...path] = line.split("\t");
        return { status, path: path.join("\t") };
      });
  }

  async diff(sha: string, path?: string): Promise<string> {
    const tree = await this.captureTree();
    const args = ["diff", "--no-renames", sha, tree];
    if (path) args.push("--", path);
    return this.git(args);
  }

  async restore(sha: string): Promise<RestoreResult> {
    const snapshots = await this.list();
    const target = snapshots.find((snapshot) => snapshot.sha === sha);
    if (!target) {
      throw new Error(`Not a nomoreide snapshot: ${sha}`);
    }

    const preRestore = await this.snapshot(`pre-restore (${target.label})`);
    // Everything that differs between the snapshot and the just-captured
    // current state. Additions must be deleted by hand: `git restore` only
    // writes files that exist in the source tree, it never removes extras.
    const changes = await this.git([
      "diff",
      "--no-renames",
      "--name-status",
      sha,
      preRestore.sha,
    ]);
    const deletedPaths: string[] = [];
    let restoredFiles = 0;
    for (const line of changes.split("\n")) {
      if (line.trim() === "") continue;
      const [status, ...rest] = line.split("\t");
      const path = rest.join("\t");
      if (status === "A") {
        await this.removeWorktreeFile(path);
        deletedPaths.push(path);
      } else {
        restoredFiles += 1;
      }
    }
    if (restoredFiles > 0) {
      // --worktree only: the user's index stays untouched, mirroring snapshot().
      await this.git(["restore", "--source", sha, "--worktree", "--", ":/"]);
    }
    return { preRestore, restoredFiles, deletedPaths };
  }

  /** Drop snapshots beyond the newest `keep`; returns how many were removed. */
  async prune(keep = 50): Promise<number> {
    const snapshots = await this.list();
    const stale = snapshots.slice(Math.max(0, keep));
    for (const snapshot of stale) {
      await this.git(["update-ref", "-d", snapshot.ref]);
    }
    return stale.length;
  }

  /**
   * Write the current working tree (tracked + untracked, `.gitignore`
   * respected) as a tree object via a throwaway index file.
   */
  private async captureTree(): Promise<string> {
    const indexFile = join(tmpdir(), `nomoreide-index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      const head = await this.headSha();
      await this.git(["read-tree", ...(head ? [head] : ["--empty"])], env);
      await this.git(["add", "-A"], env);
      return (await this.git(["write-tree"], env)).trim();
    } finally {
      await rm(indexFile, { force: true });
    }
  }

  private async headSha(): Promise<string | null> {
    try {
      return (await this.git(["rev-parse", "--verify", "HEAD"])).trim();
    } catch {
      return null; // repository without commits yet
    }
  }

  private async removeWorktreeFile(path: string): Promise<void> {
    const absolute = resolve(this.cwd, path);
    if (!absolute.startsWith(resolve(this.cwd) + sep)) {
      throw new Error(`Refusing to delete outside the repository: ${path}`);
    }
    await rm(absolute, { force: true });
  }

  private async git(
    args: string[],
    env?: Record<string, string>,
  ): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd: this.cwd,
      maxBuffer: 256 * 1024 * 1024,
      env: env ? { ...process.env, ...env } : process.env,
    });
    return stdout;
  }
}

function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "snapshot";
}
