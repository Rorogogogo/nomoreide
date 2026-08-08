/**
 * Rust-core implementation of {@link VercelApi}, over Tauri `invoke()` (desktop).
 *
 * This previously re-exported the HTTP implementation, which only worked under
 * `tauri:dev` — its relative `/api/vercel/*` fetches resolved through the Vite
 * dev proxy, and a packaged build (which loads the frontend over the asset
 * protocol, with no HTTP server in the Rust core) 404'd on every call. Each
 * method now maps onto a Rust command instead.
 *
 * The Rust commands return the same shapes the Node routes do, so the mapping
 * is mostly unwrapping the envelope the shared contract expects.
 */
import {
  tauri_vercelConnect,
  tauri_vercelDeploymentAction,
  tauri_vercelDeploymentLogs,
  tauri_vercelDisconnect,
  tauri_vercelEnvValue,
  tauri_vercelGetDeployment,
  tauri_vercelGetProject,
  tauri_vercelListDeployments,
  tauri_vercelListDomains,
  tauri_vercelListEnv,
  tauri_vercelListProjects,
  tauri_vercelOAuthPhase,
  tauri_vercelOAuthStart,
  tauri_vercelRuntimeLogs,
  tauri_vercelSetProject,
  tauri_vercelSetScope,
  tauri_vercelStatus,
} from "./tauri-bridge.js";
import type {
  VercelApi,
  VercelBuildLogLine,
  VercelDeployment,
  VercelDeploymentDetail,
  VercelDomain,
  VercelEnvVar,
  VercelOAuthPhase,
  VercelProject,
  VercelRuntimeLogLine,
  VercelStatusInfo,
} from "./vercel-api.js";

export const tauriVercelApi: VercelApi = {
  async getVercelStatus() {
    return (await tauri_vercelStatus()) as VercelStatusInfo;
  },

  async connectVercel(input) {
    await tauri_vercelConnect(input.source, input.source === "stored" ? input.token : undefined);
  },

  async startVercelOAuth() {
    const res = await tauri_vercelOAuthStart();
    return { url: res.url };
  },

  async getVercelOAuthPhase() {
    return (await tauri_vercelOAuthPhase()) as VercelOAuthPhase;
  },

  async disconnectVercel() {
    await tauri_vercelDisconnect();
  },

  async setVercelScope(scope) {
    await tauri_vercelSetScope(scope.teamId, scope.teamSlug);
  },

  async listVercelProjects(search) {
    const res = (await tauri_vercelListProjects(search)) as {
      projects: VercelProject[];
      linkedProjectId?: string | null;
    };
    return {
      projects: res.projects ?? [],
      linkedProjectId: res.linkedProjectId ?? undefined,
    };
  },

  async setVercelProject(projectId) {
    await tauri_vercelSetProject(projectId);
  },

  async getVercelProject() {
    return (await tauri_vercelGetProject()) as VercelProject;
  },

  async listVercelEnv() {
    return ((await tauri_vercelListEnv()) ?? []) as VercelEnvVar[];
  },

  async getVercelEnvValue(id) {
    return (await tauri_vercelEnvValue(id)).value;
  },

  async createVercelEnv() {
    throw new Error("Adding an environment variable is not supported in desktop mode");
  },

  async updateVercelEnv() {
    throw new Error("Editing an environment variable is not supported in desktop mode");
  },

  async deleteVercelEnv() {
    throw new Error("Deleting an environment variable is not supported in desktop mode");
  },

  async listVercelDomains() {
    return ((await tauri_vercelListDomains()) ?? []) as VercelDomain[];
  },

  async listVercelDeployments(opts = {}) {
    const res = (await tauri_vercelListDeployments(opts.target, opts.limit)) as {
      deployments: VercelDeployment[];
      project: VercelProject | null;
    };
    return { deployments: res.deployments ?? [], project: res.project ?? null };
  },

  async getVercelDeployment(id) {
    return (await tauri_vercelGetDeployment(id)) as VercelDeploymentDetail;
  },

  async getVercelDeploymentLogs(id, limit) {
    return ((await tauri_vercelDeploymentLogs(id, limit)) ?? []) as VercelBuildLogLine[];
  },

  async getVercelRuntimeLogs(id, limit) {
    return ((await tauri_vercelRuntimeLogs(id, limit)) ?? []) as VercelRuntimeLogLine[];
  },

  async runVercelDeploymentAction(id, action) {
    const res = await tauri_vercelDeploymentAction(id, action);
    return { deployment: res.deployment };
  },
};
