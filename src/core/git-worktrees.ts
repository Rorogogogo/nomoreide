import { execFile } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HEADS_PREFIX = "refs/heads/";
const UNSAFE_PATH_SEGMENT = /[^a-zA-Z0-9._-]+/g;

export interface GitWorktree {
  path: string;
  head: string;
  createdAt?: number;
  branch?: string;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  lockedReason?: string;
  prunable: boolean;
  prunableReason?: string;
  primary: boolean;
  dirty: boolean;
}

interface ParsedWorktree extends Omit<GitWorktree, "dirty" | "primary"> {}

export interface CreateWorktreeOptions {
  branch: string;
  createBranch: boolean;
  baseRef?: string;
  destination?: string;
  projectName?: string;
}

export function defaultWorktreesDir(homeDir = homedir()): string {
  const override = process.env.NOMOREIDE_WORKTREES_DIR?.trim();
  return resolve(override || join(homeDir, ".nomoreide", "worktrees"));
}

export function parseGitWorktreePorcelain(output: string): ParsedWorktree[] {
  return output
    .split("\0\0")
    .map((record) => record.split("\0").filter(Boolean))
    .filter((fields) => fields.some((field) => field.startsWith("worktree ")))
    .map((fields) => {
      const value = (key: string) => {
        const field = fields.find((item) => item === key || item.startsWith(`${key} `));
        return field?.slice(key.length).trim() || undefined;
      };
      const branchRef = value("branch");
      return {
        path: value("worktree") ?? "",
        head: value("HEAD") ?? "",
        branch: branchRef?.startsWith(HEADS_PREFIX)
          ? branchRef.slice(HEADS_PREFIX.length)
          : branchRef,
        bare: fields.includes("bare"),
        detached: fields.includes("detached"),
        locked: fields.some((field) => field === "locked" || field.startsWith("locked ")),
        lockedReason: value("locked"),
        prunable: fields.some(
          (field) => field === "prunable" || field.startsWith("prunable "),
        ),
        prunableReason: value("prunable"),
      };
    })
    .filter((worktree) => worktree.path);
}

export class GitWorktreeManager {
  constructor(
    private readonly repositoryPath: string,
    private readonly managedRoot = defaultWorktreesDir(),
  ) {}

  async list(): Promise<GitWorktree[]> {
    const { stdout } = await execFileAsync(
      "git",
      ["worktree", "list", "--porcelain", "-z"],
      { cwd: this.repositoryPath },
    );
    const parsed = parseGitWorktreePorcelain(stdout);
    return Promise.all(
      parsed.map(async (worktree, index) => ({
        ...worktree,
        createdAt: await worktreeCreatedAt(worktree.path),
        primary: index === 0,
        dirty: worktree.bare ? false : await isDirty(worktree.path),
      })),
    );
  }

  async create(options: CreateWorktreeOptions): Promise<GitWorktree> {
    const branch = requireBranchName(options.branch);
    const project = safeSegment(options.projectName || basename(this.repositoryPath));
    const destination =
      options.destination ??
      join(this.managedRoot, project, safeSegment(branch));

    await mkdir(resolve(destination, ".."), { recursive: true });
    const args = ["worktree", "add"];
    if (options.createBranch) {
      args.push("-b", branch, destination, options.baseRef?.trim() || "HEAD");
    } else {
      args.push(destination, branch);
    }
    await execFileAsync("git", args, { cwd: this.repositoryPath });

    const canonicalDestination = await canonicalPath(destination);
    const worktrees = await this.list();
    const canonicalPaths = await Promise.all(
      worktrees.map((worktree) => canonicalPath(worktree.path)),
    );
    const created = worktrees.find(
      (_worktree, index) => canonicalPaths[index] === canonicalDestination,
    );
    if (!created) {
      throw new Error(`Git created the worktree but it could not be found: ${destination}`);
    }
    return created;
  }

  async remove(path: string): Promise<void> {
    const target = await canonicalPath(path);
    const worktrees = await this.list();
    const canonicalPaths = await Promise.all(
      worktrees.map((worktree) => canonicalPath(worktree.path)),
    );
    const worktree = worktrees.find(
      (_candidate, index) => canonicalPaths[index] === target,
    );
    if (!worktree) throw new Error("Unknown worktree.");
    if (worktree.primary) throw new Error("The primary worktree cannot be removed.");
    if (worktree.locked) throw new Error("Unlock this worktree before removing it.");
    if (worktree.dirty) {
      throw new Error("Commit, stash, or discard this worktree's changes before removing it.");
    }
    await execFileAsync("git", ["worktree", "remove", worktree.path], {
      cwd: this.repositoryPath,
    });
  }

  async prune(): Promise<void> {
    await execFileAsync("git", ["worktree", "prune"], {
      cwd: this.repositoryPath,
    });
  }
}

function requireBranchName(value: string): string {
  const branch = value.trim();
  if (!branch || branch.startsWith("-") || branch.includes("\0")) {
    throw new Error("A valid branch name is required.");
  }
  return branch;
}

function safeSegment(value: string): string {
  const result = value
    .trim()
    .replace(UNSAFE_PATH_SEGMENT, "-")
    .replace(/^-+|-+$/g, "");
  if (!result || result === "." || result === "..") {
    throw new Error("Could not derive a safe worktree folder name.");
  }
  return result;
}

async function isDirty(path: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: path },
    );
    return stdout.length > 0;
  } catch {
    return false;
  }
}

async function canonicalPath(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

async function worktreeCreatedAt(path: string): Promise<number | undefined> {
  try {
    const createdAt = (await stat(path)).birthtimeMs;
    return Number.isFinite(createdAt) && createdAt > 0 ? createdAt : undefined;
  } catch {
    return undefined;
  }
}
