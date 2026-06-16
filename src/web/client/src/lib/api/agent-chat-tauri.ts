/** Rust-core implementation of {@link AgentChatApi}, over Tauri `invoke()` (desktop). */
import {
  tauriListen,
  tauri_getAgentChatStatus,
  tauri_setChatProvider,
  tauri_startAgentChat,
} from "./tauri-bridge.js";
import type {
  AgentChatApi,
  AgentChatProviderInfo,
  AgentChatProviderOption,
  AgentStreamEvent,
} from "./agent-chat-api.js";

// The saved/default provider, used when a turn doesn't override it explicitly.
let _tauriProvider = "claude";

export const tauriAgentChatApi: AgentChatApi = {
  async getAgentChatStatus() {
    const raw = await tauri_getAgentChatStatus();
    const status = raw as {
      configured: boolean;
      approvals: boolean;
      provider: AgentChatProviderInfo;
      providers: AgentChatProviderOption[];
    };
    _tauriProvider = status.provider?.id ?? "claude";
    return { ...status, providers: status.providers ?? [] };
  },

  async setChatProvider(provider) {
    const raw = await tauri_setChatProvider(provider);
    const selected = (raw as AgentChatProviderInfo) ?? null;
    _tauriProvider = selected?.id ?? provider;
    return selected ?? ({ id: provider } as AgentChatProviderInfo);
  },

  // Desktop runs the agent unattended; tool approval is a no-op.
  approveAgentTool: async () => {},

  streamAgentChat(message, resumeSessionId, onEvent, signal, _autoApprove, provider) {
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
          await tauri_startAgentChat(message, resumeSessionId, provider ?? _tauriProvider);
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
  },
};
