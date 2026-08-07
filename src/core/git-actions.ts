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

export interface CheckoutDefaultAndPullResult {
  output: string;
  branch: string;
}

/**
 * Credential for a single push. The token travels through the environment into
 * a throwaway credential helper, so it never appears in `argv` (visible to any
 * process listing) and never gets written to the repository's config.
 */
export interface PushCredential {
  token: string;
  /** GitHub ignores the username for token auth; the conventional value is used. */
  username?: string;
}

/**
 * A credential helper that echoes the two values git asks for and nothing else.
 * The empty `credential.helper=` that precedes it resets the inherited helper
 * chain, so the machine's keychain cannot answer first and quietly push as the
 * account the user did not select.
 */
// The `$NAME` reads are expanded by the helper's own shell, not by JavaScript —
// interpolating them here would put the token in `argv`, which is what this avoids.
const CREDENTIAL_HELPER =
  '!f() { echo "username=$NOMOREIDE_GIT_USERNAME"; echo "password=$NOMOREIDE_GIT_PASSWORD"; }; f';

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
  async push(
    options: { remote?: string; credential?: PushCredential } = {},
  ): Promise<PushResult> {
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

    const credential = options.credential;
    const output = await this.git(
      credential ? [...credentialConfigArgs(), ...args] : args,
      credential
        ? {
            NOMOREIDE_GIT_USERNAME: credential.username ?? "x-access-token",
            NOMOREIDE_GIT_PASSWORD: credential.token,
          }
        : undefined,
    );

    return { output, branch, setUpstream };
  }

  /** Fast-forward the current branch from its configured upstream. */
  async pull(): Promise<string> {
    return this.git(["pull", "--ff-only"]);
  }

  /**
   * Merge a branch into the current branch without opening an editor. The
   * header command surface must not leave a repository half-merged, so a
   * conflict is automatically aborted and returned as an error.
   */
  async merge(branch: string): Promise<string> {
    const target = await this.validBranchRef(branch);
    await this.assertCleanWorkingTree("merge");
    try {
      return await this.git(["merge", "--no-edit", target]);
    } catch (error) {
      await this.git(["merge", "--abort"]).catch(() => undefined);
      throw new Error(`Merge failed and was aborted.\n${errorMessage(error)}`);
    }
  }

  /** Rebase the current branch onto another branch, aborting on conflicts. */
  async rebase(branch: string): Promise<string> {
    const target = await this.validBranchRef(branch);
    await this.assertCleanWorkingTree("rebase");
    try {
      return await this.git(["rebase", target]);
    } catch (error) {
      await this.git(["rebase", "--abort"]).catch(() => undefined);
      throw new Error(`Rebase failed and was aborted.\n${errorMessage(error)}`);
    }
  }

  async checkoutDefaultAndPull(options: { remote?: string } = {}): Promise<CheckoutDefaultAndPullResult> {
    const remote = options.remote ?? "origin";
    const branch = await this.defaultBranch(remote);
    const switchOutput = await this.git(["switch", branch]);
    const pullOutput = await this.git(["pull", "--ff-only"]);
    return {
      branch,
      output: [`Switched to ${branch}.`, switchOutput, pullOutput].filter(Boolean).join("\n").trim(),
    };
  }

  private async defaultBranch(remote: string): Promise<string> {
    const remoteHead = (await this.git(["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]).catch(() => "")).trim();
    const fromRemoteHead = remoteHead.startsWith(`${remote}/`) ? remoteHead.slice(remote.length + 1) : remoteHead;
    if (fromRemoteHead) return fromRemoteHead;

    const branches = await this.git(["branch", "--format=%(refname:short)"]);
    const names = branches.split("\n").map((line) => line.trim()).filter(Boolean);
    if (names.includes("main")) return "main";
    if (names.includes("master")) return "master";
    throw new Error(`Could not determine default branch for ${remote}.`);
  }

  private async validBranchRef(branch: string): Promise<string> {
    const target = branch.trim();
    if (!target) throw new Error("branch is required");
    await this.git(["check-ref-format", "--branch", target]);
    return target;
  }

  private async assertCleanWorkingTree(operation: string): Promise<void> {
    const status = await this.git(["status", "--porcelain=v1", "--untracked-files=all"]);
    if (status.trim()) {
      throw new Error(`Commit or stash local changes before ${operation}.`);
    }
  }

  private async git(args: string[], env?: Record<string, string>): Promise<string> {
    const secret = env?.NOMOREIDE_GIT_PASSWORD;
    try {
      const { stdout, stderr } = await execFileAsync("git", args, {
        cwd: this.cwd,
        env: env ? { ...process.env, ...env } : undefined,
        maxBuffer: 16 * 1024 * 1024,
      });
      return redact(stdout || stderr, secret);
    } catch (error) {
      if (error instanceof Error) {
        const withStreams = error as Error & { stdout?: string; stderr?: string };
        throw new Error(
          redact(
            (withStreams.stderr || withStreams.stdout || error.message).trim(),
            secret,
          ),
        );
      }
      throw error;
    }
  }
}

/** Exported so tests can drive `git credential fill` through the real helper. */
export function credentialConfigArgs(): string[] {
  return ["-c", "credential.helper=", "-c", `credential.helper=${CREDENTIAL_HELPER}`];
}

/**
 * Push output and git's error text are surfaced verbatim in the UI and written
 * to the timeline, so scrub the token on the way out even though the helper
 * keeps it off the command line.
 */
export function redact(text: string, secret: string | undefined): string {
  if (!secret) return text;
  return text.split(secret).join("***");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
