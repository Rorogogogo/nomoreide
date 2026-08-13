/**
 * This view's binding to the generic provider seam.
 *
 * Every call in `@/lib/api`'s provider surface takes a provider id first; this
 * file supplies it once so the components below keep calling
 * `listVercelDeployments()` with no argument. When a second provider arrives
 * and this view becomes generic, `PROVIDER_ID` becomes a prop and this is the
 * only file that changes.
 */
import {
  connectProvider,
  createProviderEnv,
  deleteProviderEnv,
  disconnectProvider,
  getProviderDeployment,
  getProviderDeploymentLogs,
  getProviderEnvValue,
  getProviderOAuthPhase,
  getProviderProject,
  getProviderRuntimeLogs,
  getProviderStatus,
  listProviderDeployments,
  listProviderDomains,
  listProviderEnv,
  listProviderProjects,
  runProviderDeploymentAction,
  setProviderProject,
  setProviderScope,
  startProviderOAuth,
  updateProviderEnv,
} from "@/lib/api";
import type { ProviderApi } from "@/lib/api";

export const PROVIDER_ID = "vercel";

type Rest<F> = F extends (providerId: string, ...rest: infer R) => infer T
  ? (...args: R) => T
  : never;

const bind = <K extends keyof ProviderApi>(
  method: ProviderApi[K],
): Rest<ProviderApi[K]> =>
  ((...args: unknown[]) =>
    (method as (...a: unknown[]) => unknown)(PROVIDER_ID, ...args)) as Rest<ProviderApi[K]>;

export const getVercelStatus = bind<"getStatus">(getProviderStatus);
export const connectVercel = bind<"connect">(connectProvider);
export const startVercelOAuth = bind<"startOAuth">(startProviderOAuth);
export const getVercelOAuthPhase = bind<"getOAuthPhase">(getProviderOAuthPhase);
export const disconnectVercel = bind<"disconnect">(disconnectProvider);
export const setVercelScope = bind<"setScope">(setProviderScope);
export const listVercelProjects = bind<"listProjects">(listProviderProjects);
export const setVercelProject = bind<"setProject">(setProviderProject);
export const getVercelProject = bind<"getProject">(getProviderProject);
export const listVercelEnv = bind<"listEnv">(listProviderEnv);
export const getVercelEnvValue = bind<"getEnvValue">(getProviderEnvValue);
export const createVercelEnv = bind<"createEnv">(createProviderEnv);
export const updateVercelEnv = bind<"updateEnv">(updateProviderEnv);
export const deleteVercelEnv = bind<"deleteEnv">(deleteProviderEnv);
export const listVercelDomains = bind<"listDomains">(listProviderDomains);
export const listVercelDeployments = bind<"listDeployments">(listProviderDeployments);
export const getVercelDeployment = bind<"getDeployment">(getProviderDeployment);
export const getVercelDeploymentLogs = bind<"getDeploymentLogs">(getProviderDeploymentLogs);
export const getVercelRuntimeLogs = bind<"getRuntimeLogs">(getProviderRuntimeLogs);
export const runVercelDeploymentAction =
  bind<"runDeploymentAction">(runProviderDeploymentAction);
