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
  AgentEnvRegistryInstallResult,
  AgentEnvRegistryPublishResult,
  AgentEnvRegistryStatus,
  AgentEnvSettings,
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

  async getAgentEnvSettings(agent) {
    const response = await requestJson<{ ok: true; settings: AgentEnvSettings }>(
      `/api/agent-env/settings/${agent}`,
    );
    return response.settings;
  },

  async saveAgentEnvSettings(agent, content) {
    const response = await requestJson<{
      ok: true;
      settings: AgentEnvSettings;
      backup: string | null;
    }>(`/api/agent-env/settings/${agent}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    return { settings: response.settings, backup: response.backup };
  },

  async setAgentEnvModel(agent, model) {
    const response = await postJson<{
      ok: true;
      settings: AgentEnvSettings;
      backup: string | null;
    }>(`/api/agent-env/settings/${agent}/model`, { model });
    return { settings: response.settings, backup: response.backup };
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

  async updateAgentEnvProfile(name, patch) {
    const response = await requestJson<{ ok: true; profile: AgentEnvProfile }>(
      `/api/agent-env/profiles/${encodeURIComponent(name)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      },
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

  async refreshAgentEnvProfile(name, agent) {
    const response = await postJson<{ ok: true; profile: AgentEnvProfile }>(
      `/api/agent-env/profiles/${encodeURIComponent(name)}/refresh`,
      { agent },
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

  async getRegistryAuthStatus() {
    const response = await requestJson<{ ok: true } & AgentEnvRegistryStatus>(
      "/api/agent-env/auth/status",
    );
    const { ok: _ok, ...status } = response;
    return status;
  },

  async startRegistryAuth() {
    const response = await postJson<{ ok: true; url: string; state: string }>(
      "/api/agent-env/auth/start",
      {},
    );
    return { url: response.url, state: response.state };
  },

  async getRegistryAuthOutcome(state) {
    return requestJson<{ status: string; message?: string }>(
      `/api/agent-env/auth/outcome?state=${encodeURIComponent(state)}`,
    );
  },

  async registryLogout() {
    await postJson("/api/agent-env/auth/logout", {});
  },

  async publishAgentEnvProfile({ name, ...body }) {
    return postJson<AgentEnvRegistryPublishResult>(
      `/api/agent-env/profiles/${encodeURIComponent(name)}/publish`,
      body,
    );
  },

  async installAgentEnvProfileFromRegistry(input) {
    return postJson<AgentEnvRegistryInstallResult>(
      "/api/agent-env/profiles/install-from-registry",
      input,
    );
  },
};
