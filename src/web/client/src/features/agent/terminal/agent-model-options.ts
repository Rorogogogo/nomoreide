import type { AgentChatProviderInfo } from "@/lib/api";

export interface AgentModelOption {
  /** Value passed to the CLI's `--model` / `-m` flag. */
  id: string;
  label: string;
  /** One-line hint shown beside the label in the picker. */
  hint?: string;
}

/**
 * Convenience catalogue for the dock's model picker — *not* an authority on
 * what each CLI accepts. Provider line-ups move faster than this repo releases,
 * so every entry is a suggestion and the picker always offers a free-text field
 * whose value is passed through untouched (the server validates it only for
 * argv safety). "Default" is absent on purpose: pinning nothing is its own
 * option, and no model name safely stands in for "whatever the CLI picks".
 *
 * Claude entries are aliases rather than dated ids because the CLI resolves an
 * alias to the current model in that tier, so this list does not go stale.
 */
export const AGENT_MODEL_OPTIONS: Record<
  AgentChatProviderInfo["id"],
  AgentModelOption[]
> = {
  claude: [
    { id: "fable", label: "Fable" },
    { id: "opus", label: "Opus" },
    { id: "sonnet", label: "Sonnet" },
    { id: "haiku", label: "Haiku" },
  ],
  codex: [
    { id: "gpt-5-codex", label: "GPT-5 Codex" },
    { id: "gpt-5", label: "GPT-5" },
  ],
};

export function agentModelOptions(
  provider: AgentChatProviderInfo["id"],
): AgentModelOption[] {
  return AGENT_MODEL_OPTIONS[provider] ?? [];
}

/** Short label for a pinned model, falling back to the raw id for custom entries. */
export function agentModelLabel(
  provider: AgentChatProviderInfo["id"],
  model: string | undefined,
): string | undefined {
  if (!model) return undefined;
  return agentModelOptions(provider).find((option) => option.id === model)?.label ?? model;
}
