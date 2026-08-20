import type { GitHubWorkflowRun } from "@/lib/api";

/**
 * Prompt for the GitHub Actions page's "fix this failing run" affordance. We
 * hand the agent the run's identity + URL and point it at the failing logs
 * (`gh run view <id> --log-failed`); it pulls them itself rather than us pasting
 * a wall of log into chat. An optional one-line intent overrides the default
 * "find the cause and fix it" task.
 */
export function buildFixRunPrompt(run: GitHubWorkflowRun, input?: string): string {
  const task = input?.trim()
    ? input.trim()
    : "Figure out why it failed (read the failing step's logs), then fix the underlying issue in the code. Explain what was wrong before you change anything.";
  return [
    `Workflow run "${run.name}" #${run.run_number} failed on \`${run.head_branch}\` (commit ${run.head_sha.slice(0, 7)}): ${run.html_url}`,
    "",
    task,
    "",
    `Pull the failing logs with \`gh run view ${run.id} --log-failed\` (or your GitHub tools) to see the errors.`,
  ].join("\n");
}
