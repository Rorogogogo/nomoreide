import {
  approveAgentTool,
  streamAgentChat,
  type AgentChatProviderInfo,
  type AgentStreamEvent,
} from "@/lib/api";

export interface RunHeadlessAgentTaskOptions {
  prompt: string;
  provider?: AgentChatProviderInfo["id"];
  autoApprove?: boolean;
  signal?: AbortSignal;
}

/** Runs one isolated agent session and returns its complete textual result. */
export async function runHeadlessAgentTask({
  prompt,
  provider,
  autoApprove = false,
  signal,
}: RunHeadlessAgentTaskOptions): Promise<string> {
  let text = "";
  let sessionId: string | undefined;
  let streamError: Error | undefined;
  const approvals: Promise<void>[] = [];

  const onEvent = (event: AgentStreamEvent) => {
    if (event.type === "session") {
      sessionId = event.sessionId;
    } else if (event.type === "text") {
      text += event.text;
    } else if (event.type === "error") {
      streamError = new Error(event.message);
    } else if (event.type === "approval_request") {
      approvals.push(
        sessionId
          ? approveAgentTool(
              sessionId,
              event.requestId,
              autoApprove ? "allow" : "deny",
            )
          : Promise.reject(new Error("Agent requested approval before starting a session")),
      );
    }
  };

  await streamAgentChat(prompt, undefined, onEvent, signal, autoApprove, provider);
  await Promise.all(approvals);
  if (streamError) throw streamError;
  return text.trim();
}
