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

export interface AgentChatStatus {
  configured: boolean;
  approvals: boolean;
  provider: AgentChatProviderInfo;
}

export interface AgentChatApi {
  /** Whether the selected agent CLI is available, and whether tool calls need approval. */
  getAgentChatStatus(): Promise<AgentChatStatus>;
  /** Answer a pending tool-approval prompt for the given session. */
  approveAgentTool(
    sessionId: string,
    requestId: string,
    decision: "allow" | "deny",
  ): Promise<void>;
  /**
   * Send one user message and stream events back. `resumeSessionId` continues a
   * prior session. Calls `onEvent` for each parsed event; resolves when the
   * stream ends. Pass `signal` to cancel.
   */
  streamAgentChat(
    message: string,
    resumeSessionId: string | undefined,
    onEvent: (event: AgentStreamEvent) => void,
    signal?: AbortSignal,
    autoApprove?: boolean,
  ): Promise<void>;
}
