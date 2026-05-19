import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitFileStatus {
  path: string;
  index: string;
  workingTree: string;
}

export interface GitStatus {
  branch: string;
  files: GitFileStatus[];
}

export interface GitLogEntry {
  hash: string;
  subject: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  upstream?: string;
}

export class GitManager {
  constructor(private readonly cwd = process.cwd()) {}

  async status(): Promise<GitStatus> {
    const [branch, porcelain] = await Promise.all([
      this.git(["branch", "--show-current"]),
      this.git(["status", "--porcelain=v1", "--untracked-files=all"]),
    ]);

    return {
      branch: branch.trim(),
      files: porcelain
        .split("\n")
        .filter(Boolean)
        .map((line) => ({
          index: line[0] ?? " ",
          workingTree: line[1] ?? " ",
          path: line.slice(3),
        })),
    };
  }

  async diff(path?: string): Promise<string> {
    return this.git(path ? ["diff", "--", path] : ["diff"]);
  }

  async stagedDiff(path?: string): Promise<string> {
    return this.git(path ? ["diff", "--cached", "--", path] : ["diff", "--cached"]);
  }

  async fileDiff(file: GitFileStatus): Promise<string> {
    if (file.index === "?" && file.workingTree === "?") {
      return this.untrackedDiff(file.path);
    }

    if (file.workingTree.trim()) {
      return this.diff(file.path);
    }

    if (file.index.trim()) {
      return this.stagedDiff(file.path);
    }

    return this.diff(file.path);
  }

  async log(limit = 10): Promise<GitLogEntry[]> {
    const output = await this.git([
      "log",
      `-${limit}`,
      "--pretty=format:%H%x09%s",
    ]);

    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash = "", subject = ""] = line.split("\t");
        return { hash, subject };
      });
  }

  async branches(): Promise<GitBranch[]> {
    const output = await this.git([
      "branch",
      "--all",
      "--format=%(refname)%09%(HEAD)%09%(upstream:short)",
    ]);

    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [refName = "", head = "", upstream = ""] = line.split("\t");
        const remote = refName.startsWith("refs/remotes/");
        const name = remote
          ? refName.slice("refs/remotes/".length)
          : refName.replace(/^refs\/heads\//, "");
        return {
          name,
          current: head === "*",
          remote,
          upstream: upstream || undefined,
        };
      })
      .filter((branch) => branch.name && !branch.name.endsWith("/HEAD"));
  }

  async switchBranch(branch: string): Promise<string> {
    const name = requireName(branch, "branch");
    const remoteBranches = (await this.branches()).filter((item) => item.remote);
    const isRemoteBranch = remoteBranches.some((item) => item.name === name);

    return this.git(isRemoteBranch ? ["switch", "--track", name] : ["switch", name]);
  }

  async createBranch(branch: string): Promise<string> {
    return this.git(["switch", "-c", requireName(branch, "branch")]);
  }

  async fetch(): Promise<string> {
    return this.git(["fetch", "--prune"]);
  }

  async stage(paths: string[]): Promise<string> {
    requirePaths(paths);
    return this.git(["add", "--", ...paths]);
  }

  async unstage(paths: string[]): Promise<string> {
    requirePaths(paths);
    return this.git(["restore", "--staged", "--", ...paths]);
  }

  async commit(message: string): Promise<string> {
    if (!message.trim()) {
      throw new Error("commit message is required");
    }

    return this.git(["commit", "-m", message]);
  }

  private async git(args: string[]): Promise<string> {
    try {
      const { stdout, stderr } = await execFileAsync("git", args, {
        cwd: this.cwd,
      });
      return stdout || stderr;
    } catch (error) {
      if (isExecError(error)) {
        throw new Error((error.stderr || error.stdout || error.message).trim());
      }
      throw error;
    }
  }

  private async untrackedDiff(path: string): Promise<string> {
    const fullPath = resolveInside(this.cwd, path);
    const content = await readFile(fullPath, "utf8");
    const lines = content.split("\n");
    const hasTrailingNewline = lines[lines.length - 1] === "";
    const contentLines = hasTrailingNewline ? lines.slice(0, -1) : lines;
    const hunkLength = Math.max(contentLines.length, 1);
    const diffLines = [
      `diff --git a/${path} b/${path}`,
      "new file mode 100644",
      "index 0000000..0000000",
      "--- /dev/null",
      `+++ b/${path}`,
      `@@ -0,0 +1,${hunkLength} @@`,
      ...contentLines.map((line) => `+${line}`),
    ];

    if (!hasTrailingNewline) {
      diffLines.push("\\ No newline at end of file");
    }

    return `${diffLines.join("\n")}\n`;
  }
}

function resolveInside(root: string, path: string): string {
  const rootPath = resolve(root);
  const targetPath = resolve(rootPath, path);
  if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${sep}`)) {
    throw new Error("file path must stay inside the repository");
  }
  return targetPath;
}

function requireName(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  return trimmed;
}

function requirePaths(paths: string[]): void {
  if (paths.length === 0 || paths.some((path) => !path.trim())) {
    throw new Error("at least one file path is required");
  }
}

function isExecError(
  error: unknown,
): error is Error & { stdout?: string; stderr?: string } {
  return error instanceof Error;
}
