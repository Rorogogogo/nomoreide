import type { GitGraphCommit } from "@/lib/api";

/**
 * Build the "do this with the commit" prompt. The user types one line of intent
 * inline on the commit row; we wrap it with the commit's identity and subject so
 * the agent has context, and it pulls the full diff itself via `git show`.
 */
export function buildCommitPrompt(commit: GitGraphCommit, input: string): string {
  const short = commit.hash.slice(0, 7);
  return [
    `About commit \`${short}\` — "${commit.subject}" by ${commit.author}:`,
    "",
    input,
    "",
    `Run \`git show ${commit.hash}\` to see the diff if you need it.`,
  ].join("\n");
}
