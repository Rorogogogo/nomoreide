/** Node HTTP-server implementation of {@link AgentEnvApi} (the web/MCP backend). */
import { requestJson } from "./client.js";
import type {
  AgentEnvApi,
  AgentEnvApplyResult,
  AgentEnvAvailability,
  AgentEnvChangePreview,
  AgentEnvConfig,
  AgentEnvDoctorCheck,
  AgentEnvSnapshotResult,
} from "./agent-env-api.js";

function postJson<T>(url: string, body: unknown): Promise<T> {
  return requestJson<T>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

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

  async previewAgentEnvChanges(changes) {
    const response = await postJson<{ ok: true } & AgentEnvChangePreview>(
      "/api/agent-env/changes/preview",
      { changes },
    );
    return { valid: response.valid, items: response.items, agents: response.agents };
  },

  async applyAgentEnvChanges(changes) {
    return postJson<AgentEnvApplyResult>("/api/agent-env/changes/apply", { changes });
  },

  async snapshotAgentEnv(agent) {
    const response = await postJson<{ ok: true } & AgentEnvSnapshotResult>(
      "/api/agent-env/snapshot",
      { agent },
    );
    return { agent: response.agent, backups: response.backups };
  },
};
