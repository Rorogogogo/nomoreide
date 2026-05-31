/**
 * Handed to the dock agent to onboard a project from just a Git URL. The whole
 * point is to be AI-native: the agent decides how to run the repo and sets it
 * up end-to-end, instead of making the user fill in a form. It only asks when
 * something is genuinely ambiguous.
 */
export function onboardRepoPrompt(url?: string): string {
  const target = url?.trim();
  const lines = [
    target
      ? `Onboard this repository into NoMoreIDE and get it running: ${target}`
      : "I want to add a project to NoMoreIDE from a Git URL. First ask me for the repository URL (for example: `https://github.com/owner/repo`).",
    "",
    "Then set it up end-to-end yourself — don't make me fill in a form:",
    "1. Call the `nomoreide_onboard_repo` tool with the URL to clone and analyze it.",
    "   It returns the clone path, a profile (manifests, Docker/compose, env keys,",
    "   README excerpt), and ranked proposals with install-command hints.",
    "2. Pick the best proposal straight from that result. Trust the profile — don't",
    "   crawl the repo with Read/Glob/Grep or shell file reads; it already has what",
    "   you need. Only ask me if it's genuinely ambiguous (e.g. several equally-likely",
    "   apps in a monorepo) — otherwise choose sensible defaults.",
    "3. Install dependencies if needed (run the install command in the clone path).",
    "4. Register it with `nomoreide_register_service` using the returned clone path as",
    "   the cwd, then register it as a git repo with `nomoreide_git_register_repository`",
    "   so it shows in the Git tab.",
    "   If the onboard result includes any `databases`, register each one with",
    "   `nomoreide_register_database` (use its name, engine, and url) so it shows in the",
    "   Database tab.",
    "5. Start it with `nomoreide_start_service` and confirm it came up (check its logs).",
    "",
    "Keep me posted as you go, but keep decisions to yourself unless you're truly stuck.",
    "When it's running, end your message with the service name in a fenced `service`",
    "block so I get Start / Open buttons for it, e.g.:",
    "```service",
    "backend",
    "```",
  ];
  return lines.join("\n");
}
