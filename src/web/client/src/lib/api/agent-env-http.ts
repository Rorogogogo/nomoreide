/** Node HTTP-server implementation of {@link AgentEnvApi} (the web/MCP backend). */
import { requestJson } from "./client.js";
import type {
  AgentEnvApi,
  AgentEnvAvailability,
  AgentEnvConfig,
  AgentEnvDoctorCheck,
} from "./agent-env-api.js";

export const httpAgentEnvApi: AgentEnvApi = {
  async getAgentEnvAgents() {
    const response = await requestJson<{ ok: true; agents: AgentEnvAvailability[] }>(
      "/api/agent-env/agents",
    );
    return response.agents;
  },

  async getAgentEnvConfigs() {
    const response = await requestJson<{ ok: true; configs: AgentEnvConfig[] }>(
      "/api/agent-env/live",
    );
    return response.configs;
  },

  async getAgentEnvDoctor() {
    const response = await requestJson<{
      ok: true;
      checks: AgentEnvDoctorCheck[];
      hasIssues: boolean;
    }>("/api/agent-env/doctor");
    return { checks: response.checks, hasIssues: response.hasIssues };
  },
};
