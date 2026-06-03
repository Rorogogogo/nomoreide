/**
 * Build the "suggest a commit message" prompt. Sent to the dock when the user
 * clicks the AI button on the commit composer. The agent inspects the staged
 * diff itself (via its git tools) and replies with a message the user can paste
 * into the composer — we keep the commit action itself a deterministic button.
 */
export function buildCommitMessagePrompt(options: {
  branch?: string;
  stagedFiles: string[];
}): string {
  const lines = [
    "Write a concise Git commit message for my currently staged changes.",
    "",
    "- Inspect the staged diff yourself (`git diff --cached` or the `nomoreide_git_staged_diff` tool).",
    "- Use a conventional-commit style subject (≤ 72 chars), then a short body if it helps.",
    "- Reply with ONLY the commit message in a code block so I can copy it — don't commit it yourself.",
  ];
  if (options.branch) {
    lines.push("", `Branch: \`${options.branch}\``);
  }
  if (options.stagedFiles.length) {
    lines.push(
      "",
      "Staged files:",
      ...options.stagedFiles.slice(0, 40).map((path) => `- ${path}`),
    );
    if (options.stagedFiles.length > 40) {
      lines.push(`- …and ${options.stagedFiles.length - 40} more`);
    }
  }
  return lines.join("\n");
}
