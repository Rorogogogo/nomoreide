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
  let approvalError: unknown;
  let hasApprovalError = false;
  const approvals: Promise<void>[] = [];
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });

  const onEvent = (event: AgentStreamEvent) => {
    if (event.type === "session") {
      sessionId = event.sessionId;
    } else if (event.type === "text") {
      text += event.text;
    } else if (event.type === "error") {
      streamError = new Error(event.message);
    } else if (event.type === "approval_request") {
      const approval = sessionId
        ? approveAgentTool(sessionId, event.requestId, autoApprove ? "allow" : "deny")
        : Promise.reject(new Error("Agent requested approval before starting a session"));
      approvals.push(
        approval.catch((caught) => {
          if (!hasApprovalError) {
            hasApprovalError = true;
            approvalError = caught;
          }
          controller.abort();
        }),
      );
    }
  };

  let caughtStreamError: unknown;
  try {
    await streamAgentChat(
      prompt,
      undefined,
      onEvent,
      controller.signal,
      autoApprove,
      provider,
    );
  } catch (caught) {
    caughtStreamError = caught;
  } finally {
    await Promise.allSettled(approvals);
    signal?.removeEventListener("abort", forwardAbort);
  }
  if (hasApprovalError) throw approvalError;
  if (caughtStreamError) throw caughtStreamError;
  if (streamError) throw streamError;
  return text.trim();
}
