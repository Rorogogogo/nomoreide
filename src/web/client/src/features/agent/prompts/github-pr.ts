import type { GitHubPR } from "@/lib/api";

/**
 * Prompts for the GitHub page's PR affordances. The user types one line of
 * intent inline (header spark for the whole PR, file spark for one file); we
 * wrap it with the PR's identity so the agent has context, and it pulls the
 * actual diff itself (`gh pr diff <n>` or its GitHub tools) — keeping the dock
 * transcript light rather than pasting a huge diff into chat.
 */

function prHeader(pr: GitHubPR): string {
  return `Pull request #${pr.number} — "${pr.title}" (${pr.head.ref} → ${pr.base.ref}, by ${pr.user.login}):`;
}

export function buildPrAskPrompt(pr: GitHubPR, input: string): string {
  return [
    prHeader(pr),
    "",
    input,
    "",
    `Pull the diff with \`gh pr diff ${pr.number}\` (or your GitHub tools) if you need it.`,
  ].join("\n");
}

export function buildPrFileAskPrompt(pr: GitHubPR, path: string, input: string): string {
  return [
    prHeader(pr),
    "",
    `Focus on the file \`${path}\`. ${input}`,
    "",
    `Pull the diff with \`gh pr diff ${pr.number}\` (or your GitHub tools) to see its changes.`,
  ].join("\n");
}
