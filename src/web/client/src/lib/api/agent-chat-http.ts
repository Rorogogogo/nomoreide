/** Node HTTP-server implementation of {@link AgentChatApi} (the web/MCP backend). */
import { requestJson } from "./client.js";
import type {
  AgentChatApi,
  AgentChatProviderInfo,
  AgentStreamEvent,
} from "./agent-chat-api.js";

export const httpAgentChatApi: AgentChatApi = {
  async getAgentChatStatus() {
    const res = await requestJson<{
      ok: true;
      configured: boolean;
      approvals: boolean;
      provider: AgentChatProviderInfo;
    }>("/api/agent/chat/status");
    return { configured: res.configured, approvals: res.approvals, provider: res.provider };
  },

  async approveAgentTool(sessionId, requestId, decision) {
    await requestJson("/api/agent/chat/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, requestId, decision }),
    });
  },

  async streamAgentChat(message, resumeSessionId, onEvent, signal, autoApprove) {
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
  },
};
