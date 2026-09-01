/** Deploy-provider API entry point shared by browser and desktop. */
import type { ProviderApi } from "./provider-api.js";
import { httpProviderApi } from "./provider-http.js";

const api: ProviderApi = httpProviderApi;

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
