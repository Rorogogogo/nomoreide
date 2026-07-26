const CLAUDE_BIN = process.env.NOMOREIDE_CLAUDE_BIN || "claude";
const CODEX_BIN = process.env.NOMOREIDE_CODEX_BIN || "codex";

export type InteractiveAgentProvider = "claude" | "codex";

export interface InteractiveAgentInvocation {
  shell: string;
  args: string[];
}

export interface InteractiveAgentOptions {
  /** Prior session to reopen, from `listAgentTranscripts`. */
  resumeId?: string;
}

/**
 * Session ids are spawned as argv entries rather than through a shell, so the
 * risk is not injection but a malformed id starting with `-` and being read as
 * a flag by the CLI. Both providers issue UUIDs, so anything else is refused.
 */
const SESSION_ID = /^[0-9a-fA-F-]{8,64}$/;

/**
 * Both CLIs accept a positional initial prompt and queue it themselves until
 * the interactive TUI is ready. Passing it as an argument is what makes the
 * first prompt reliable — injecting keystrokes after spawn raced the TUI's
 * startup (trust dialogs, first paint) and the paste was silently dropped.
 *
 * A blank prompt starts the provider's interactive TUI without queueing a
 * first turn. Resuming reopens a recorded session and replays its history, so
 * an empty prompt there just returns to the conversation where it left off.
 */
export function buildInteractiveAgentInvocation(
  provider: string,
  prompt: string,
  { resumeId }: InteractiveAgentOptions = {},
): InteractiveAgentInvocation {
  if (resumeId !== undefined && !SESSION_ID.test(resumeId)) {
    throw new Error(`Invalid session id: ${String(resumeId)}`);
  }
  // A resumed session carries its own history; an empty prompt must not be
  // forwarded as an empty positional argument.
  const trailing = prompt.trim() ? [prompt] : [];

  switch (provider) {
    case "claude":
      return {
        shell: CLAUDE_BIN,
        args: resumeId ? ["--resume", resumeId, ...trailing] : trailing,
      };
    case "codex":
      return {
        shell: CODEX_BIN,
        args: resumeId
          ? ["--no-alt-screen", "resume", resumeId, ...trailing]
          : ["--no-alt-screen", ...trailing],
      };
    default:
      throw new Error(`Unsupported agent provider: ${String(provider)}`);
  }
}
