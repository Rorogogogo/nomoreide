/** Agent-chat API entry point shared by browser and desktop. */
import type { AgentChatApi } from "./agent-chat-api.js";
import { httpAgentChatApi } from "./agent-chat-http.js";

const api: AgentChatApi = httpAgentChatApi;

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
