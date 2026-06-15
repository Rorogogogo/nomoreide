import { requestJson } from "./client.js";
import {
  isTauri,
  tauriListen,
  tauri_getAgentChatStatus,
  tauri_startAgentChat,
} from "./tauri-bridge.js";

// Tracks which CLI is available so streamAgentChat can pass the right provider.
let _tauriProvider = "claude";

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

/** Whether the selected agent CLI is available, and whether tool calls need approval. */
export async function getAgentChatStatus(): Promise<{
  configured: boolean;
  approvals: boolean;
  provider: AgentChatProviderInfo;
}> {
  if (isTauri()) {
    const raw = await tauri_getAgentChatStatus();
    const status = raw as { configured: boolean; approvals: boolean; provider: AgentChatProviderInfo };
    _tauriProvider = status.provider?.id ?? "claude";
    return status;
  }
  const res = await requestJson<{
    ok: true;
    configured: boolean;
    approvals: boolean;
    provider: AgentChatProviderInfo;
  }>("/api/agent/chat/status");
  return { configured: res.configured, approvals: res.approvals, provider: res.provider };
}

/** Answer a pending tool-approval prompt for the given Claude Code session. */
export async function approveAgentTool(
  sessionId: string,
  requestId: string,
  decision: "allow" | "deny",
): Promise<void> {
  if (isTauri()) return;
  await requestJson("/api/agent/chat/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, requestId, decision }),
  });
}

/**
 * Send one user message and stream SSE events back. `resumeSessionId` continues
 * a prior Claude Code session. Calls `onEvent` for each parsed event; resolves
 * when the stream ends. Pass `signal` to cancel.
 */
export async function streamAgentChat(
  message: string,
  resumeSessionId: string | undefined,
  onEvent: (event: AgentStreamEvent) => void,
  signal?: AbortSignal,
  autoApprove?: boolean,
): Promise<void> {
  if (isTauri()) {
    let unlisten: (() => void) | undefined;
    let done = false;
    return new Promise<void>((resolve) => {
      (async () => {
        unlisten = await tauriListen("agent-chat-event", (payload) => {
          if (done) return;
          const event = payload as AgentStreamEvent;
          onEvent(event);
          if (event.type === "done" || event.type === "error") {
            done = true;
            unlisten?.();
            resolve();
          }
        });

        if (signal?.aborted) {
          done = true; unlisten?.(); resolve(); return;
        }
        signal?.addEventListener("abort", () => {
          if (!done) { done = true; unlisten?.(); resolve(); }
        });

        try {
          await tauri_startAgentChat(message, resumeSessionId, _tauriProvider);
        } catch (e) {
          done = true; unlisten?.();
          onEvent({ type: "error", message: String(e) });
          onEvent({ type: "done", stopReason: "error" });
          resolve();
        }
      })().catch((e) => {
        if (!done) {
          done = true; unlisten?.();
          onEvent({ type: "error", message: String(e) });
          onEvent({ type: "done", stopReason: "error" });
          resolve();
        }
      });
    });
  }
  const response = await fetch("/api/agent/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, resumeSessionId, autoApprove }),
    signal,
  });

  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => undefined);
    throw new Error(body?.error || response.statusText || "Agent request failed");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line; each carries one `data:` JSON line.
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
      if (dataLine) {
        const json = dataLine.slice("data:".length).trim();
        if (json) {
          try {
            onEvent(JSON.parse(json) as AgentStreamEvent);
          } catch {
            // Ignore malformed frames (e.g. the initial `retry:` directive).
          }
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}
