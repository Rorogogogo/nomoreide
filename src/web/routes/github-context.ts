import {
  optionalGitHubContext,
  requireGitHubContext,
  type GitHubContext,
} from "../../core/github-context.js";
import { GitManager } from "../../core/git-manager.js";
import type { ConfigStore } from "../../core/config-store.js";
import type { CiFailureSnapshot } from "../../core/workflow-triggers.js";

export { optionalGitHubContext, requireGitHubContext, type GitHubContext };

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
