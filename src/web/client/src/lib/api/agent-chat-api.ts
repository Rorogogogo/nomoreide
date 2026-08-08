/**
 * Agent-chat API surface — the single contract both backends implement (status,
 * tool-approval, and the streaming send). See {@link ../git-api} for the
 * shared-interface seam rationale.
 */

/** Mirror of the server's AgentStreamEvent (core/agent-runtime.ts). */
export type AgentStreamEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; preview: string; isError: boolean }
  | { type: "approval_request"; requestId: string; name: string; input: unknown }
  | { type: "done"; stopReason: string | null }
  | { type: "error"; message: string };

export interface AgentChatProviderInfo {
  id: "claude" | "codex";
  label: string;
  commandName: string;
  installHint: string;
  intro: string;
}

/** A selectable provider plus whether its CLI is installed/runnable. */
export interface AgentChatProviderOption extends AgentChatProviderInfo {
  configured: boolean;
}

/** Saved model pin per provider; a missing key means "let the CLI decide". */
export type AgentChatModels = Partial<
  Record<AgentChatProviderInfo["id"], string>
>;

export interface AgentChatStatus {
  configured: boolean;
  approvals: boolean;
  /** The currently selected provider (saved choice, else detected default). */
  provider: AgentChatProviderInfo;
  /** Every provider the user can switch between, with install state. */
  providers: AgentChatProviderOption[];
  /** Model each provider is pinned to, if any. */
  models: AgentChatModels;
}

export interface AgentChatApi {
  /** Whether the selected agent CLI is available, and whether tool calls need approval. */
  getAgentChatStatus(): Promise<AgentChatStatus>;
  /** Persist which provider the dock chat drives; returns the now-selected one. */
  setChatProvider(provider: AgentChatProviderInfo["id"]): Promise<AgentChatProviderInfo>;
  /** Pin the model new sessions use for a provider; null clears the pin. */
  setChatModel(
    provider: AgentChatProviderInfo["id"],
    model: string | null,
  ): Promise<AgentChatModels>;
  /** Answer a pending tool-approval prompt for the given session. */
  approveAgentTool(
    sessionId: string,
    requestId: string,
    decision: "allow" | "deny",
  ): Promise<void>;
  /**
   * Send one user message and stream events back. `resumeSessionId` continues a
   * prior session. `provider` overrides the saved choice for this turn. Calls
   * `onEvent` for each parsed event; resolves when the stream ends. Pass `signal`
   * to cancel.
   */
  streamAgentChat(
    message: string,
    resumeSessionId: string | undefined,
    onEvent: (event: AgentStreamEvent) => void,
    signal?: AbortSignal,
    autoApprove?: boolean,
    provider?: AgentChatProviderInfo["id"],
  ): Promise<void>;
}
