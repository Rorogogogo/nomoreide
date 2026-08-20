/** Node HTTP-server implementation of {@link ProviderApi} (the web/MCP backend). */
import { requestJson } from "./client.js";
import type {
  ProviderApi,
  ProviderDeployment,
  ProviderDeploymentDetail,
  ProviderDomain,
  ProviderEnvVar,
  ProviderLogLine,
  ProviderManifest,
  ProviderOAuthPhase,
  ProviderProject,
  ProviderStatusInfo,
} from "./provider-api.js";

const base = (providerId: string) => `/api/providers/${encodeURIComponent(providerId)}`;

export const httpProviderApi: ProviderApi = {
  async listProviders() {
    const res = await requestJson<{ ok: true; providers: ProviderManifest[] }>("/api/providers");
    return res.providers ?? [];
  },

  async getStatus(providerId) {
    return requestJson<{ ok: true } & ProviderStatusInfo>(`${base(providerId)}/status`);
  },

  async connect(providerId, input) {
    const body = new URLSearchParams({ source: input.source });
    if (input.source === "stored") body.set("token", input.token);
    await requestJson(`${base(providerId)}/connect`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  },

  async startOAuth(providerId) {
    const res = await requestJson<{ ok: true; url: string }>(
      `${base(providerId)}/oauth/start`,
      { method: "POST" },
    );
    return { url: res.url };
  },

  async getOAuthPhase(providerId) {
    return requestJson<ProviderOAuthPhase>(`${base(providerId)}/oauth/status`);
  },

  async disconnect(providerId) {
    await requestJson(`${base(providerId)}/connect`, { method: "DELETE" });
  },

  async setScope(providerId, scope) {
    await requestJson(`${base(providerId)}/scope`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(scope),
    });
  },

  async listProjects(providerId, search) {
    const params = search ? `?search=${encodeURIComponent(search)}` : "";
    const res = await requestJson<{
      ok: true;
      projects: ProviderProject[];
      linkedProjectId?: string;
    }>(`${base(providerId)}/projects${params}`);
    return { projects: res.projects, linkedProjectId: res.linkedProjectId };
  },

  async setProject(providerId, projectId) {
    await requestJson(`${base(providerId)}/project`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: projectId ?? "" }),
    });
  },

  async getProject(providerId) {
    const res = await requestJson<{ ok: true; project: ProviderProject }>(
      `${base(providerId)}/project`,
    );
    return res.project;
  },

  async listEnv(providerId) {
    const res = await requestJson<{ ok: true; env: ProviderEnvVar[] }>(`${base(providerId)}/env`);
    return res.env;
  },

  async getEnvValue(providerId, id) {
    const res = await requestJson<{ ok: true; value: string }>(
      `${base(providerId)}/env/${encodeURIComponent(id)}/reveal`,
      { method: "POST" },
    );
    return res.value;
  },

  async createEnv(providerId, input) {
    const res = await requestJson<{ ok: true; env: ProviderEnvVar }>(`${base(providerId)}/env`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return res.env;
  },

  async updateEnv(providerId, id, input) {
    const res = await requestJson<{ ok: true; env: ProviderEnvVar }>(
      `${base(providerId)}/env/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    return res.env;
  },

  async deleteEnv(providerId, id) {
    await requestJson(`${base(providerId)}/env/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  async listDomains(providerId) {
    const res = await requestJson<{ ok: true; domains: ProviderDomain[] }>(
      `${base(providerId)}/domains`,
    );
    return res.domains;
  },

  async listDeployments(providerId, opts = {}) {
    const params = new URLSearchParams();
    if (opts.target) params.set("target", opts.target);
    if (opts.limit) params.set("limit", String(opts.limit));
    const query = params.toString();
    const res = await requestJson<{
      ok: true;
      deployments: ProviderDeployment[];
      project: ProviderProject | null;
    }>(`${base(providerId)}/deployments${query ? `?${query}` : ""}`);
    return { deployments: res.deployments, project: res.project };
  },

  async getDeployment(providerId, id) {
    const res = await requestJson<{ ok: true; deployment: ProviderDeploymentDetail }>(
      `${base(providerId)}/deployments/${encodeURIComponent(id)}`,
    );
    return res.deployment;
  },

  async getDeploymentLogs(providerId, id, limit) {
    const params = limit ? `?limit=${limit}` : "";
    const res = await requestJson<{ ok: true; logs: ProviderLogLine[] }>(
      `${base(providerId)}/deployments/${encodeURIComponent(id)}/logs${params}`,
    );
    return res.logs;
  },

  async getRuntimeLogs(providerId, id, limit) {
    const params = limit ? `?limit=${limit}` : "";
    const res = await requestJson<{ ok: true; logs: ProviderLogLine[] }>(
      `${base(providerId)}/deployments/${encodeURIComponent(id)}/runtime-logs${params}`,
    );
    return res.logs;
  },

  async runDeploymentAction(providerId, id, action) {
    const res = await requestJson<{
      ok: true;
      deployment?: { id: string; url: string | null };
    }>(`${base(providerId)}/deployments/${encodeURIComponent(id)}/${encodeURIComponent(action)}`, {
      method: "POST",
    });
    return { deployment: res.deployment };
  },
};
