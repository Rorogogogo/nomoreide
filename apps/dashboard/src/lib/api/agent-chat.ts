/**
 * Agent-chat API entry point. Picks the backend implementation once at module
 * load (`isTauri()` → Rust core, else Node HTTP) and re-exports its methods as
 * the named functions the rest of the app already imports — never a per-function
 * `if (isTauri())` branch.
 */
import { isTauri } from "./tauri-bridge.js";
import type { AgentChatApi } from "./agent-chat-api.js";
import { httpAgentChatApi } from "./agent-chat-http.js";
import { tauriAgentChatApi } from "./agent-chat-tauri.js";

const api: AgentChatApi = isTauri() ? tauriAgentChatApi : httpAgentChatApi;

export const {
  getAgentChatStatus,
  setChatProvider,
  setChatModel,
  approveAgentTool,
  streamAgentChat,
} = api;

export type {
  AgentChatApi,
  AgentStreamEvent,
  AgentChatModels,
  AgentChatProviderInfo,
  AgentChatProviderOption,
  AgentChatStatus,
} from "./agent-chat-api.js";
