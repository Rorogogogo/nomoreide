import { execFile } from "node:child_process";
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

export class GitManager {
  constructor(private readonly cwd = process.cwd()) {}

  async status(): Promise<GitStatus> {
    const [branch, porcelain] = await Promise.all([
      this.git(["branch", "--show-current"]),
      this.git(["status", "--porcelain=v1"]),
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
