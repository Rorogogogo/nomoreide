/** Node HTTP-server implementation of {@link VercelApi} (the web/MCP backend). */
import { requestJson } from "./client.js";
import type {
  VercelApi,
  VercelOAuthPhase,
  VercelBuildLogLine,
  VercelDeployment,
  VercelDeploymentDetail,
  VercelDomain,
  VercelEnvVar,
  VercelProject,
  VercelRuntimeLogLine,
  VercelStatusInfo,
} from "./vercel-api.js";

export const httpVercelApi: VercelApi = {
  async getVercelStatus() {
    const res = await requestJson<{ ok: true } & VercelStatusInfo>("/api/vercel/status");
    return res;
  },

  async connectVercel(input) {
    const body = new URLSearchParams({ source: input.source });
    if (input.source === "stored") body.set("token", input.token);
    await requestJson("/api/vercel/connect", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  },

  async startVercelOAuth() {
    const res = await requestJson<{ ok: true; url: string }>("/api/vercel/oauth/start", {
      method: "POST",
    });
    return { url: res.url };
  },

  async getVercelOAuthPhase() {
    return requestJson<VercelOAuthPhase>("/api/vercel/oauth/status");
  },

  async disconnectVercel() {
    await requestJson("/api/vercel/connect", { method: "DELETE" });
  },

  async setVercelScope(scope) {
    await requestJson("/api/vercel/scope", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(scope),
    });
  },

  async listVercelProjects(search) {
    const params = search ? `?search=${encodeURIComponent(search)}` : "";
    const res = await requestJson<{
      ok: true;
      projects: VercelProject[];
      linkedProjectId?: string;
    }>(`/api/vercel/projects${params}`);
    return { projects: res.projects, linkedProjectId: res.linkedProjectId };
  },

  async setVercelProject(projectId) {
    await requestJson("/api/vercel/project", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: projectId ?? "" }),
    });
  },

  async getVercelProject() {
    const res = await requestJson<{ ok: true; project: VercelProject }>("/api/vercel/project");
    return res.project;
  },

  async listVercelEnv() {
    const res = await requestJson<{ ok: true; env: VercelEnvVar[] }>("/api/vercel/env");
    return res.env;
  },

  async getVercelEnvValue(id) {
    const res = await requestJson<{ ok: true; value: string }>(
      `/api/vercel/env/${encodeURIComponent(id)}/reveal`,
      { method: "POST" },
    );
    return res.value;
  },

  async listVercelDomains() {
    const res = await requestJson<{ ok: true; domains: VercelDomain[] }>("/api/vercel/domains");
    return res.domains;
  },

  async listVercelDeployments(opts = {}) {
    const params = new URLSearchParams();
    if (opts.target) params.set("target", opts.target);
    if (opts.limit) params.set("limit", String(opts.limit));
    const query = params.toString();
    const res = await requestJson<{
      ok: true;
      deployments: VercelDeployment[];
      project: VercelProject | null;
    }>(`/api/vercel/deployments${query ? `?${query}` : ""}`);
    return { deployments: res.deployments, project: res.project };
  },

  async getVercelDeployment(id) {
    const res = await requestJson<{ ok: true; deployment: VercelDeploymentDetail }>(
      `/api/vercel/deployments/${encodeURIComponent(id)}`,
    );
    return res.deployment;
  },

  async getVercelDeploymentLogs(id, limit) {
    const params = limit ? `?limit=${limit}` : "";
    const res = await requestJson<{ ok: true; logs: VercelBuildLogLine[] }>(
      `/api/vercel/deployments/${encodeURIComponent(id)}/logs${params}`,
    );
    return res.logs;
  },

  async getVercelRuntimeLogs(id, limit) {
    const params = limit ? `?limit=${limit}` : "";
    const res = await requestJson<{ ok: true; logs: VercelRuntimeLogLine[] }>(
      `/api/vercel/deployments/${encodeURIComponent(id)}/runtime-logs${params}`,
    );
    return res.logs;
  },

  async runVercelDeploymentAction(id, action) {
    const res = await requestJson<{
      ok: true;
      deployment?: { uid: string; url: string | null };
    }>(`/api/vercel/deployments/${encodeURIComponent(id)}/${action}`, { method: "POST" });
    return { deployment: res.deployment };
  },
};
