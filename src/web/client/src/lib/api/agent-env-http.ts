/** Node HTTP-server implementation of {@link AgentEnvApi} (the web/MCP backend). */
import { requestJson } from "./client.js";
import type {
  AgentEnvApi,
  AgentEnvApplyResult,
  AgentEnvAvailability,
  AgentEnvChangePreview,
  AgentEnvConfig,
  AgentEnvDoctorCheck,
  AgentEnvProfile,
  AgentEnvProfileApplyPreview,
  AgentEnvProfileApplyResult,
  AgentEnvProfileImportResult,
  AgentEnvProfileSummary,
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

  async listAgentEnvProfiles() {
    const response = await requestJson<{ ok: true; profiles: AgentEnvProfileSummary[] }>(
      "/api/agent-env/profiles",
    );
    return response.profiles;
  },

  async getAgentEnvProfile(name) {
    const response = await requestJson<{ ok: true; profile: AgentEnvProfile }>(
      `/api/agent-env/profiles/${encodeURIComponent(name)}`,
    );
    return response.profile;
  },

  async deleteAgentEnvProfile(name) {
    await requestJson(`/api/agent-env/profiles/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  },

  async snapshotAgentEnvProfile(input) {
    const response = await postJson<{ ok: true; profile: AgentEnvProfile }>(
      "/api/agent-env/profiles/snapshot",
      input,
    );
    return response.profile;
  },

  async previewAgentEnvProfileApply(name, agent) {
    return postJson<AgentEnvProfileApplyPreview>(
      `/api/agent-env/profiles/${encodeURIComponent(name)}/apply-preview`,
      { agent },
    );
  },

  async applyAgentEnvProfile({ name, agent, skip }) {
    return postJson<AgentEnvProfileApplyResult>(
      `/api/agent-env/profiles/${encodeURIComponent(name)}/apply`,
      { agent, skip },
    );
  },

  async exportAgentEnvProfile(name) {
    const response = await postJson<{ ok: true; archivePath: string }>(
      `/api/agent-env/profiles/${encodeURIComponent(name)}/export`,
      {},
    );
    return { archivePath: response.archivePath };
  },

  async importAgentEnvProfile(file, options) {
    return requestJson<AgentEnvProfileImportResult>(
      `/api/agent-env/profiles/import${options?.force ? "?force=1" : ""}`,
      { method: "POST", headers: { "content-type": "application/gzip" }, body: file },
    );
  },
};
