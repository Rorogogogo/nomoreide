/**
 * Vercel API entry point. Picks the backend implementation once at module load
 * (`isTauri()` → Rust core, else Node HTTP) and re-exports its methods as the
 * named functions the rest of the app imports — never a per-function
 * `if (isTauri())` branch.
 */
import { isTauri } from "./tauri-bridge.js";
import type { VercelApi } from "./vercel-api.js";
import { httpVercelApi } from "./vercel-http.js";
import { tauriVercelApi } from "./vercel-tauri.js";

const api: VercelApi = isTauri() ? tauriVercelApi : httpVercelApi;

export const {
  getVercelStatus,
  connectVercel,
  startVercelOAuth,
  getVercelOAuthPhase,
  disconnectVercel,
  setVercelScope,
  listVercelProjects,
  setVercelProject,
  getVercelProject,
  listVercelEnv,
  getVercelEnvValue,
  createVercelEnv,
  updateVercelEnv,
  deleteVercelEnv,
  listVercelDomains,
  listVercelDeployments,
  getVercelDeployment,
  getVercelDeploymentLogs,
  getVercelRuntimeLogs,
  runVercelDeploymentAction,
} = api;

export type {
  VercelApi,
  VercelBuildLogLine,
  VercelConnection,
  VercelConnectionStatus,
  VercelDeployment,
  VercelDeploymentAction,
  VercelDeploymentDetail,
  VercelDeploymentState,
  VercelDomain,
  VercelDomainVerification,
  VercelEnvVar,
  VercelOAuthPhase,
  VercelProject,
  VercelRuntimeLogLine,
  VercelStatusInfo,
  VercelTeam,
} from "./vercel-api.js";
