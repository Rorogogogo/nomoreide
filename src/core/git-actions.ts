import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PushResult {
  /** Combined stdout/stderr from `git push` — what the user would see in a terminal. */
  output: string;
  /** The branch that was pushed. */
  branch: string;
  /** True when an upstream had to be set (first push of a new branch). */
  setUpstream: boolean;
}

/**
 * Write-capable Git operations, kept deliberately separate from the read-safe
 * {@link GitManager}. These reach outward (push) or move refs, so they live in
 * their own module and callers are expected to confirm before invoking them.
 *
 * Still intentionally excludes the irreversible footguns (`reset --hard`,
 * `clean -f`, `push --force`, `branch -D`) — those would need their own
 * explicit, separately-guarded surface.
 */
export class GitActions {
  constructor(private readonly cwd = process.cwd()) {}

  /**
   * Push the current branch to its remote. When the branch has no upstream yet
   * (a freshly created local branch), this sets one with `-u origin <branch>`
   * so subsequent pushes and ahead/behind tracking work.
   */
  async push(options: { remote?: string } = {}): Promise<PushResult> {
    const remote = options.remote ?? "origin";
    const branch = (await this.git(["branch", "--show-current"])).trim();
    if (!branch) {
      throw new Error("cannot push in a detached HEAD state");
    }

    const upstream = (
      await this.git([
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
      ]).catch(() => "")
    ).trim();

    const setUpstream = !upstream;
    const args = setUpstream
      ? ["push", "--set-upstream", remote, branch]
      : ["push"];

    return { output: await this.git(args), branch, setUpstream };
  }

  private async git(args: string[]): Promise<string> {
    try {
      const { stdout, stderr } = await execFileAsync("git", args, {
        cwd: this.cwd,
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout || stderr;
    } catch (error) {
      if (error instanceof Error) {
        const withStreams = error as Error & { stdout?: string; stderr?: string };
        throw new Error(
          (withStreams.stderr || withStreams.stdout || error.message).trim(),
        );
      }
      throw error;
    }
  }
}
