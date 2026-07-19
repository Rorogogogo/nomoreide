import { GitManager } from "../../core/git-manager.js";
import { GitHubManager } from "../../core/github-manager.js";
import type { ConfigStore } from "../../core/config-store.js";
import type { CiFailureSnapshot } from "../../core/workflow-triggers.js";

export interface GitHubContext {
  manager: GitHubManager;
  owner: string;
  repo: string;
}

export async function requireGitHubContext(
  configStore: ConfigStore,
  gitCwd: string,
): Promise<GitHubContext> {
  const config = await configStore.load();
  const token = configStore.getGithubToken(config);
  if (!token) {
    throw new Error("No GitHub token configured. Add one via POST /api/github/token.");
  }

  const remoteUrl = await new GitManager(gitCwd).remoteUrl("origin");
  if (!remoteUrl) {
    throw new Error("No git remote 'origin' found.");
  }

  const parsed = GitHubManager.parseRemoteUrl(remoteUrl);
  if (!parsed) {
    throw new Error(`Could not parse GitHub remote URL: ${remoteUrl}`);
  }

  return {
    manager: new GitHubManager(token, parsed.owner, parsed.repo),
    owner: parsed.owner,
    repo: parsed.repo,
  };
}

export async function optionalGitHubContext(
  configStore: ConfigStore,
  gitCwd: string,
): Promise<GitHubContext | null> {
  try {
    return await requireGitHubContext(configStore, gitCwd);
  } catch {
    return null;
  }
}

/** GitHub run conclusions that mean "this check failed", not just "not green". */
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);

/**
 * Poll source for `ci-failure` workflow triggers: report the selected repo's
 * current branch CI when it's failing, else `null` (green / still running /
 * GitHub unavailable). Keyed on the latest workflow run's commit sha so a
 * trigger fires once per failing commit, not once per workflow.
 */
export async function readCiFailure(
  configStore: ConfigStore,
  gitCwd: string,
): Promise<CiFailureSnapshot | null> {
  const ctx = await optionalGitHubContext(configStore, gitCwd);
  if (!ctx) return null;

  const status = await new GitManager(gitCwd).status().catch(() => null);
  const branch = status?.branch;
  if (!branch) return null;

  const runs = await ctx.manager.listWorkflowRuns(branch).catch(() => []);
  if (runs.length === 0) return null;

  // The API returns newest first; scope to the most recent commit's runs so we
  // don't mix a failing old commit with a green new one.
  const sha = runs[0]!.head_sha;
  const latest = runs.filter((run) => run.head_sha === sha);
  const failing = latest.filter(
    (run) =>
      run.status === "completed" &&
      run.conclusion !== null &&
      FAILED_CONCLUSIONS.has(run.conclusion),
  );
  if (failing.length === 0) return null;

  return { sha, branch, failingChecks: failing.map((run) => run.name) };
}
