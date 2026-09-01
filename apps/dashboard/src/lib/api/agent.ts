/** Agent API entry point shared by browser and desktop. */
import type { AgentApi } from "./agent-api.js";
import { httpAgentApi } from "./agent-http.js";

const api: AgentApi = httpAgentApi;

export const {
  getAgentInfo,
  getMcpAuthStatuses,
  getRecentToolCalls,
  getAgentUsage,
  getAgentUsageHistory,
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
  UsageSource,
  UsageHistoryEntry,
  UsageDayBucket,
  UsageHistorySummary,
  UsageHistoryResult,
  ClaudeAgentSettings,
} from "./agent-api.js";
