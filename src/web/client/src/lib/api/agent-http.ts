/** Node HTTP-server implementation of {@link AgentApi} (the web/MCP backend). */
import { requestJson } from "./client.js";
import type {
  AgentApi,
  AgentInfo,
  ClaudeAgentSettings,
  McpAuthStatus,
  ToolCallRecord,
  UsageInfo,
} from "./agent-api.js";

export const httpAgentApi: AgentApi = {
  async getAgentInfo() {
    const response = await requestJson<{ ok: true; agent: AgentInfo }>("/api/agent");
    return response.agent;
  },

  async getMcpAuthStatuses(agent) {
    const response = await requestJson<{ ok: true; statuses: McpAuthStatus[] }>(
      `/api/agent/mcp-status?agent=${encodeURIComponent(agent)}`,
    );
    return response.statuses;
  },

  async getRecentToolCalls(limit = 100) {
    const response = await requestJson<{ ok: true; records: ToolCallRecord[] }>(
      `/api/agent/tool-calls?limit=${limit}`,
    );
    return response.records;
  },

  async getAgentUsage() {
    const response = await requestJson<{ ok: true; usage: UsageInfo }>("/api/agent/usage");
    return response.usage;
  },

  async getClaudeAgentSettings() {
    const response = await requestJson<{ ok: true; settings: ClaudeAgentSettings }>(
      "/api/agent/claude-settings",
    );
    return response.settings;
  },

  async updateClaudeAgentSettings(settings) {
    const response = await requestJson<{ ok: true; settings: ClaudeAgentSettings }>(
      "/api/agent/claude-settings",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settings),
      },
    );
    return response.settings;
  },
};
