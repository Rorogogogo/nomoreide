/**
 * Deploy-provider API entry point. Picks the backend implementation once at
 * module load (`isTauri()` → Rust core, else Node HTTP) and re-exports its
 * methods as the named functions the rest of the app imports — never a
 * per-function `if (isTauri())` branch.
 */
import { isTauri } from "./tauri-bridge.js";
import type { ProviderApi } from "./provider-api.js";
import { httpProviderApi } from "./provider-http.js";
import { tauriProviderApi } from "./provider-tauri.js";

const api: ProviderApi = isTauri() ? tauriProviderApi : httpProviderApi;

export const {
  listProviders,
  getStatus: getProviderStatus,
  connect: connectProvider,
  startOAuth: startProviderOAuth,
  getOAuthPhase: getProviderOAuthPhase,
  disconnect: disconnectProvider,
  setScope: setProviderScope,
  listProjects: listProviderProjects,
  setProject: setProviderProject,
  getProject: getProviderProject,
  listEnv: listProviderEnv,
  getEnvValue: getProviderEnvValue,
  createEnv: createProviderEnv,
  updateEnv: updateProviderEnv,
  deleteEnv: deleteProviderEnv,
  listDomains: listProviderDomains,
  listDeployments: listProviderDeployments,
  getDeployment: getProviderDeployment,
  getDeploymentLogs: getProviderDeploymentLogs,
  getRuntimeLogs: getProviderRuntimeLogs,
  runDeploymentAction: runProviderDeploymentAction,
} = api;

export type {
  DeployCapability,
  ProviderApi,
  ProviderConnection,
  ProviderConnectionStatus,
  ProviderDeployment,
  ProviderDeploymentDetail,
  ProviderDeploymentState,
  ProviderDomain,
  ProviderDomainVerification,
  ProviderEnvVar,
  ProviderLogLine,
  ProviderManifest,
  ProviderOAuthPhase,
  ProviderProject,
  ProviderScope,
  ProviderSetting,
  ProviderStatusInfo,
} from "./provider-api.js";
