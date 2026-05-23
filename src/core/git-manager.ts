import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
import { assignLanes, type GitGraphLayoutRow } from "./git-graph-layout.js";

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

export type GitGraphRefKind = "head" | "branch" | "remote" | "tag";

export interface GitGraphRef {
  name: string;
  kind: GitGraphRefKind;
}

export interface GitGraphCommit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  timestamp: number;
  subject: string;
  refs: GitGraphRef[];
  lane: number;
  laneCount: number;
  edges: GitGraphLayoutRow["edges"];
  throughLanes: number[];
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

  async graph(limit = 200): Promise<GitGraphCommit[]> {
    const recordSep = "\x1e";
    const fieldSep = "\x1f";
    const format = ["%H", "%P", "%an", "%ae", "%at", "%s"].join(fieldSep) + recordSep;

    const [logOutput, refsOutput, headHash] = await Promise.all([
      this.git([
        "log",
        "--all",
        "--date-order",
        `--max-count=${limit}`,
        `--pretty=format:${format}`,
      ]),
      this.git([
        "for-each-ref",
        "--format=%(refname)%09%(objectname)",
        "refs/heads",
        "refs/remotes",
        "refs/tags",
      ]),
      this.git(["rev-parse", "HEAD"]).catch(() => ""),
    ]);

    const refsByHash = new Map<string, GitGraphRef[]>();
    for (const line of refsOutput.split("\n").filter(Boolean)) {
      const [refName = "", hash = ""] = line.split("\t");
      if (!refName || !hash) continue;
      if (refName.endsWith("/HEAD")) continue;
      let name = refName;
      let kind: GitGraphRefKind;
      if (refName.startsWith("refs/heads/")) {
        name = refName.slice("refs/heads/".length);
        kind = "branch";
      } else if (refName.startsWith("refs/remotes/")) {
        name = refName.slice("refs/remotes/".length);
        kind = "remote";
      } else if (refName.startsWith("refs/tags/")) {
        name = refName.slice("refs/tags/".length);
        kind = "tag";
      } else {
        continue;
      }
      const list = refsByHash.get(hash) ?? [];
      list.push({ name, kind });
      refsByHash.set(hash, list);
    }

    const trimmedHead = headHash.trim();
    if (trimmedHead) {
      const list = refsByHash.get(trimmedHead) ?? [];
      list.unshift({ name: "HEAD", kind: "head" });
      refsByHash.set(trimmedHead, list);
    }

    const parsed = logOutput
      .split(recordSep)
      .map((record) => record.replace(/^\n/, ""))
      .filter((record) => record.length > 0)
      .map((record) => {
        const [hash = "", parentField = "", author = "", email = "", timestamp = "0", subject = ""] =
          record.split(fieldSep);
        return {
          hash,
          parents: parentField ? parentField.split(" ").filter(Boolean) : [],
          author,
          email,
          timestamp: Number(timestamp) || 0,
          subject,
        };
      })
      .filter((commit) => commit.hash);

    const layout = assignLanes(parsed.map(({ hash, parents }) => ({ hash, parents })));

    return parsed.map((commit, index) => ({
      ...commit,
      refs: refsByHash.get(commit.hash) ?? [],
      lane: layout[index].lane,
      laneCount: layout[index].laneCount,
      edges: layout[index].edges,
      throughLanes: layout[index].throughLanes,
    }));
  }

  async listTrackedFiles(): Promise<string[]> {
    const output = await this.git(["ls-files", "-z"]);
    return output.split("\0").filter((path) => path.length > 0);
  }

  async readTrackedFile(
    path: string,
    options: { maxBytes?: number } = {},
  ): Promise<{ content: string; truncated: boolean; binary: boolean; size: number }> {
    const maxBytes = options.maxBytes ?? 1_000_000;
    const tracked = new Set(await this.listTrackedFiles());
    if (!tracked.has(path)) {
      throw new Error("file is not tracked by git");
    }
    const fullPath = resolveInside(this.cwd, path);
    const buffer = await readFile(fullPath);
    const binary = buffer.includes(0);
    if (binary) {
      return { content: "", truncated: false, binary: true, size: buffer.length };
    }
    const truncated = buffer.length > maxBytes;
    const slice = truncated ? buffer.subarray(0, maxBytes) : buffer;
    return {
      content: slice.toString("utf8"),
      truncated,
      binary: false,
      size: buffer.length,
    };
  }

  async commitDiff(hash: string, path?: string): Promise<string> {
    const sha = this.validateHash(hash);
    const args = ["show", "--patch", "--format=", sha];
    if (path) {
      args.push("--", path);
    }
    // `git show` handles root commits (no parent) gracefully, unlike `diff <sha>^..<sha>`.
    return this.git(args);
  }

  async commitFiles(hash: string): Promise<GitFileStatus[]> {
    const sha = this.validateHash(hash);
    const output = await this.git([
      "show",
      "--name-status",
      "--format=",
      "-z",
      sha,
    ]);
    // With -z, fields are NUL-separated:
    //   regular:  STATUS \0 PATH \0
    //   rename:   R### \0 OLD \0 NEW \0   (also C### for copies)
    const files: GitFileStatus[] = [];
    const tokens = output.split("\0").filter((t) => t.length > 0);
    let i = 0;
    while (i < tokens.length) {
      const statusToken = tokens[i];
      const letter = (statusToken[0] ?? " ").toUpperCase();
      if (letter === "R" || letter === "C") {
        const newPath = tokens[i + 2];
        if (newPath) {
          files.push({ path: newPath, index: letter, workingTree: " " });
        }
        i += 3;
      } else {
        const path = tokens[i + 1];
        if (path) {
          files.push({ path, index: letter, workingTree: " " });
        }
        i += 2;
      }
    }
    return files;
  }

  private validateHash(hash: string): string {
    const sha = requireName(hash, "commit");
    if (!/^[0-9a-f]{4,64}$/i.test(sha)) {
      throw new Error("invalid commit hash");
    }
    return sha;
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
