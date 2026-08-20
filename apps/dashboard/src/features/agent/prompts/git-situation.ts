/**
 * Prompts for the dock's contextual git actions. Each turns a detected
 * situation (dirty tree, behind upstream, failing CI) into a scoped task the
 * agent can run end-to-end with its git/shell tools. Deterministic actions
 * (push) stay as buttons and don't go through here.
 */

export function buildCommitDirtyPrompt(options: {
  branch?: string;
  fileCount: number;
}): string {
  return [
    `I have ${options.fileCount} uncommitted change${options.fileCount === 1 ? "" : "s"}${
      options.branch ? ` on \`${options.branch}\`` : ""
    }.`,
    "",
    "Review the working tree (`git status` + `git diff`), stage the changes that belong together, and commit them with a clear conventional-commit message. Ask me before committing anything that looks unintended (secrets, debug code, unrelated files).",
  ].join("\n");
}

export function buildPullRebasePrompt(options: {
  branch?: string;
  behind: number;
  upstream?: string;
}): string {
  return [
    `My branch${options.branch ? ` \`${options.branch}\`` : ""} is ${options.behind} commit${
      options.behind === 1 ? "" : "s"
    } behind ${options.upstream ?? "its upstream"}.`,
    "",
    "Pull and rebase onto the upstream. If there are conflicts, walk me through resolving them — don't force anything or discard my work.",
  ].join("\n");
}

export function buildFixCiPrompt(options: {
  branch?: string;
  runName: string;
  url: string;
}): string {
  return [
    `The latest CI run (\`${options.runName}\`)${
      options.branch ? ` on \`${options.branch}\`` : ""
    } failed: ${options.url}`,
    "",
    "Figure out why it failed (check the workflow logs / the relevant test or build step), then fix the underlying issue in the code. Explain what was wrong before you change anything.",
  ].join("\n");
}
