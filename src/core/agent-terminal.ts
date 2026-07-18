const CLAUDE_BIN = process.env.NOMOREIDE_CLAUDE_BIN || "claude";
const CODEX_BIN = process.env.NOMOREIDE_CODEX_BIN || "codex";

export type InteractiveAgentProvider = "claude" | "codex";

export interface InteractiveAgentInvocation {
  shell: string;
  args: string[];
}

export function buildInteractiveAgentInvocation(
  provider: string,
  prompt: string,
): InteractiveAgentInvocation {
  if (!prompt.trim()) {
    throw new Error("Prompt is required");
  }

  switch (provider) {
    case "claude":
      return { shell: CLAUDE_BIN, args: [] };
    case "codex":
      return { shell: CODEX_BIN, args: ["--no-alt-screen"] };
    default:
      throw new Error(`Unsupported agent provider: ${String(provider)}`);
  }
}
