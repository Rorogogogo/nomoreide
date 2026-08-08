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
  /** Model to pin this session to. Omitted = whatever the CLI defaults to. */
  model?: string;
}

/**
 * Session ids are spawned as argv entries rather than through a shell, so the
 * risk is not injection but a malformed id starting with `-` and being read as
 * a flag by the CLI. Both providers issue UUIDs, so anything else is refused.
 */
const SESSION_ID = /^[0-9a-fA-F-]{8,64}$/;

/**
 * Same argv-not-shell reasoning as {@link SESSION_ID}: a model name is passed
 * as its own argv entry, so the hazard is one that starts with `-` and is read
 * as a flag. Aliases (`opus`), dated ids (`claude-haiku-4-5-20251001`) and
 * namespaced ids (`openai/gpt-5`) all have to pass, so the leading character is
 * constrained rather than the whole shape.
 */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;

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
  { resumeId, model }: InteractiveAgentOptions = {},
): InteractiveAgentInvocation {
  if (resumeId !== undefined && !SESSION_ID.test(resumeId)) {
    throw new Error(`Invalid session id: ${String(resumeId)}`);
  }
  if (model !== undefined && !MODEL_NAME.test(model)) {
    throw new Error(`Invalid model name: ${String(model)}`);
  }
  // A resumed session carries its own history; an empty prompt must not be
  // forwarded as an empty positional argument.
  const trailing = prompt.trim() ? [prompt] : [];

  switch (provider) {
    case "claude":
      return {
        shell: CLAUDE_BIN,
        args: [
          ...(model ? ["--model", model] : []),
          ...(resumeId ? ["--resume", resumeId] : []),
          ...trailing,
        ],
      };
    case "codex":
      // `-m` is a global option, so it has to precede the `resume` subcommand.
      return {
        shell: CODEX_BIN,
        args: [
          "--no-alt-screen",
          ...(model ? ["-m", model] : []),
          ...(resumeId ? ["resume", resumeId] : []),
          ...trailing,
        ],
      };
    default:
      throw new Error(`Unsupported agent provider: ${String(provider)}`);
  }
}
