const CLAUDE_BIN = process.env.NOMOREIDE_CLAUDE_BIN || "claude";
const CODEX_BIN = process.env.NOMOREIDE_CODEX_BIN || "codex";

export type InteractiveAgentProvider = "claude" | "codex";

export interface InteractiveAgentInvocation {
  shell: string;
  args: string[];
}

/**
 * Both CLIs accept a positional initial prompt and queue it themselves until
 * the interactive TUI is ready. Passing it as an argument is what makes the
 * first prompt reliable — injecting keystrokes after spawn raced the TUI's
 * startup (trust dialogs, first paint) and the paste was silently dropped.
 */
export function buildInteractiveAgentInvocation(
  provider: string,
  prompt: string,
): InteractiveAgentInvocation {
  if (!prompt.trim()) {
    throw new Error("Prompt is required");
  }

  switch (provider) {
    case "claude":
      return { shell: CLAUDE_BIN, args: [prompt] };
    case "codex":
      return { shell: CODEX_BIN, args: ["--no-alt-screen", prompt] };
    default:
      throw new Error(`Unsupported agent provider: ${String(provider)}`);
  }
}
