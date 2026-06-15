/**
 * Agent API entry point. Picks the backend implementation once at module load
 * (`isTauri()` → Rust core, else Node HTTP) and re-exports its methods as the
 * named functions the rest of the app already imports. Adding/altering an agent
 * endpoint means editing the {@link AgentApi} interface plus both implementations
 * — never a per-function `if (isTauri())` branch.
 */
import { isTauri } from "./tauri-bridge.js";
import type { AgentApi } from "./agent-api.js";
import { httpAgentApi } from "./agent-http.js";
import { tauriAgentApi } from "./agent-tauri.js";

const api: AgentApi = isTauri() ? tauriAgentApi : httpAgentApi;

export const {
  getAgentInfo,
  getMcpAuthStatuses,
  getRecentToolCalls,
  getAgentUsage,
  getClaudeAgentSettings,
  updateClaudeAgentSettings,
} = api;

export type {
  AgentApi,
  AgentMemoryFile,
  AgentSkill,
  AgentMcpServer,
  AgentPlugin,
  AgentHook,
  AgentProjectEntry,
  AgentProfile,
  AgentInfo,
  AgentName,
  McpAuthState,
  McpAuthStatus,
  ToolCallRecord,
  ClaudeModelUsage,
  ClaudeRateLimitWindow,
  ClaudeUsage,
  CodexRateLimitWindow,
  CodexUsage,
  UsageInfo,
  ClaudeAgentSettings,
} from "./agent-api.js";
