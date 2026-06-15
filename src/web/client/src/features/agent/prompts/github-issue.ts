import type { GitHubIssue } from "@/lib/api";

/**
 * Prompt for the GitHub page's issue affordance. The user types one line of
 * intent inline on the issue header; we wrap it with the issue's identity so the
 * agent has context, and it pulls the full thread itself (`gh issue view <n>
 * --comments` or its GitHub tools) rather than us pasting it into chat.
 */
export function buildIssueAskPrompt(issue: GitHubIssue, input: string): string {
  return [
    `GitHub issue #${issue.number} — "${issue.title}" (opened by ${issue.user.login}):`,
    "",
    input,
    "",
    `Read the full thread with \`gh issue view ${issue.number} --comments\` (or your GitHub tools) if you need it.`,
  ].join("\n");
}
