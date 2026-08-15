import { PRODUCTION_AFFECTING_ACTIONS, VERCEL_ACTIONS, type VercelActions } from "./vercel-actions.js";
import { VERCEL_PROVIDER_ID } from "./vercel-auth.js";
import {
  vercelRepoUrl,
  type VercelBuildLogLine,
  type VercelDeployment,
  type VercelDeploymentDetail,
  type VercelDeploymentState,
  type VercelDomain,
  type VercelEnvVar,
  type VercelManager,
  type VercelProject,
  type VercelRuntimeLogLine,
} from "./vercel-manager.js";
import type {
  DeployActionInput,
  DeployActionResult,
  DeployProvider,
  DeployProviderActions,
  DeployProviderHooks,
  DeployProviderManifest,
  ProviderDeployment,
  ProviderDeploymentDetail,
  ProviderDeploymentState,
  ProviderDomain,
  ProviderEnvVar,
  ProviderLogLine,
  ProviderProject,
  ProviderSetting,
} from "./providers/deploy-provider.js";

/**
 * Vercel as `DeployProvider` implementation #1.
 *
 * A pure adapter: every method delegates straight to `VercelManager` or
 * `VercelActions` and only reshapes the result. No REST path, no auth, and no
 * normalizer moves here — those stay in `vercel-manager.ts`, which is the file
 * that knows what Vercel's API looks like.
 */

export const VERCEL_MANIFEST: DeployProviderManifest = {
  id: VERCEL_PROVIDER_ID,
  name: "Vercel",
  kind: "deploy",
  strings: {
    en: {
      "scope.label": "Vercel scope",
      "action.redeploy": "Redeploy",
      "action.redeploy.done": "Redeploy started.",
      "action.cancel": "Cancel build",
      "action.cancel.done": "Build canceled.",
      "action.promote": "Promote",
      "action.promote.done": "Promoted to production.",
      "action.promote.confirmTitle": "Promote to production?",
      "action.promote.confirm": "Production traffic switches to this deployment immediately.",
      "action.rollback": "Roll back",
      "action.rollback.done": "Rolled back production.",
      "action.rollback.confirmTitle": "Roll production back?",
      "action.rollback.confirm":
        "Production traffic switches back to this older deployment immediately.",
    },
    zh: {
      "scope.label": "Vercel 范围",
      "action.redeploy": "重新部署",
      "action.redeploy.done": "已开始重新部署。",
      "action.cancel": "取消构建",
      "action.cancel.done": "已取消构建。",
      "action.promote": "提升至生产",
      "action.promote.done": "已提升至生产环境。",
      "action.promote.confirmTitle": "提升至生产环境？",
      "action.promote.confirm": "生产流量将立即切换到该部署。",
      "action.rollback": "回滚",
      "action.rollback.done": "已回滚生产环境。",
      "action.rollback.confirmTitle": "回滚生产环境？",
      "action.rollback.confirm": "生产流量将立即切回这个较旧的部署。",
    },
  },
  authSources: ["cli", "stored", "oauth"],
  capabilities: ["projects", "deployments", "buildLogs", "runtimeLogs", "env", "domains"],
  actions: [...VERCEL_ACTIONS],
  productionAffecting: [...PRODUCTION_AFFECTING_ACTIONS],
  // One host: the REST API and the OIDC userinfo endpoint a browser sign-in
  // uses are both on it. Notably *not* `vercel.com` — that is where the
  // dashboard links point, and a link is not a request.
  api: { hosts: ["api.vercel.com"] },
};

export const VERCEL_HOOKS: DeployProviderHooks = {
  repoUrl: vercelRepoUrl,
  linkFile: { path: ".vercel/project.json", field: "projectId" },
};

/**
 * The seven build settings Vercel exposes, in the order the settings panel
 * shows them. Kept here rather than in the manifest because the labels are
 * Vercel's own words for its own fields.
 */
const VERCEL_SETTINGS: { key: keyof VercelProject & string; label: string }[] = [
  { key: "buildCommand", label: "Build command" },
  { key: "devCommand", label: "Dev command" },
  { key: "installCommand", label: "Install command" },
  { key: "outputDirectory", label: "Output directory" },
  { key: "rootDirectory", label: "Root directory" },
  { key: "nodeVersion", label: "Node version" },
  { key: "serverlessFunctionRegion", label: "Function region" },
];

/**
 * Vercel's eight states onto the seven neutral ones.
 *
 * `INITIALIZING` folds into `building` because that is the phase Vercel's own
 * dashboard renders with the build spinner — the container is up and working,
 * it is no longer waiting in the queue. The distinction is not lost: `rawState`
 * carries `INITIALIZING` through for the deployment detail to show.
 */
const STATE_MAP: Record<VercelDeploymentState, ProviderDeploymentState> = {
  QUEUED: "queued",
  INITIALIZING: "building",
  BUILDING: "building",
  READY: "ready",
  ERROR: "error",
  CANCELED: "canceled",
  BLOCKED: "blocked",
  DELETED: "deleted",
};

export function toProviderProject(project: VercelProject): ProviderProject {
  const settings: ProviderSetting[] = [];
  for (const { key, label } of VERCEL_SETTINGS) {
    const value = project[key];
    // Absent means "the list endpoint did not return it"; null means Vercel is
    // using the framework default. Only the former is dropped from the list.
    if (value === undefined) continue;
    settings.push({ key, label, value: typeof value === "string" ? value : null });
  }
  return {
    id: project.id,
    name: project.name,
    framework: project.framework,
    updatedAt: project.updatedAt,
    link: project.link,
    settings,
  };
}

export function toProviderDeployment(deployment: VercelDeployment): ProviderDeployment {
  return {
    id: deployment.uid,
    name: deployment.name,
    url: deployment.url,
    state: STATE_MAP[deployment.state] ?? "queued",
    rawState: deployment.state,
    target: deployment.target,
    createdAt: deployment.createdAt,
    readyAt: deployment.readyAt,
    isCurrentProduction: deployment.isCurrentProduction,
    creator: deployment.creator,
    meta: deployment.meta,
    inspectorUrl: deployment.inspectorUrl,
  };
}

function toProviderDeploymentDetail(
  deployment: VercelDeploymentDetail,
): ProviderDeploymentDetail {
  return {
    ...toProviderDeployment(deployment),
    aliases: deployment.aliases,
    buildingAt: deployment.buildingAt,
    errorMessage: deployment.errorMessage,
  };
}

function toBuildLogLine(line: VercelBuildLogLine): ProviderLogLine {
  return {
    id: line.id,
    createdAt: line.createdAt,
    kind: "build",
    level: line.type,
    text: line.text,
  };
}

function toRuntimeLogLine(line: VercelRuntimeLogLine): ProviderLogLine {
  return {
    id: line.id,
    createdAt: line.createdAt,
    kind: "runtime",
    level: line.level,
    text: line.message,
    source: line.source,
    request:
      line.requestMethod || line.requestPath || line.statusCode !== undefined
        ? {
            method: line.requestMethod,
            path: line.requestPath,
            statusCode: line.statusCode,
          }
        : undefined,
  };
}

export function toProviderEnvVar(env: VercelEnvVar): ProviderEnvVar {
  return {
    id: env.id,
    key: env.key,
    environments: env.target,
    type: env.type,
    gitBranch: env.gitBranch,
    comment: env.comment,
    createdAt: env.createdAt,
    updatedAt: env.updatedAt,
  };
}

function toProviderDomain(domain: VercelDomain): ProviderDomain {
  return { ...domain };
}

/** The read-safe half, over an already-authenticated `VercelManager`. */
export function createVercelDeployProvider(manager: VercelManager): DeployProvider {
  return {
    async account() {
      return manager.viewer();
    },
    async listScopes() {
      return manager.listTeams();
    },
    async listProjects(opts) {
      return (await manager.listProjects(opts)).map(toProviderProject);
    },
    async getProject(id) {
      return toProviderProject(await manager.getProject(id));
    },
    async listDeployments(opts) {
      return (await manager.listDeployments(opts)).map(toProviderDeployment);
    },
    async getDeployment(id) {
      return toProviderDeploymentDetail(await manager.getDeployment(id));
    },
    async buildLogs(id, limit) {
      return (await manager.deploymentBuildLogs(id, limit)).map(toBuildLogLine);
    },
    async runtimeLogs(id, limit) {
      return (await manager.deploymentRuntimeLogs(id, limit)).map(toRuntimeLogLine);
    },
    async listEnv(projectId) {
      return (await manager.listEnv(projectId)).map(toProviderEnvVar);
    },
    async getEnvValue(projectId, envId) {
      return manager.getEnvValue(projectId, envId);
    },
    async listDomains(projectId) {
      return (await manager.listDomains(projectId)).map(toProviderDomain);
    },
  };
}

/**
 * The write-capable half. Kept a separate factory, resolved separately, and
 * never handed to an MCP tool — the same boundary `VercelActions` already has.
 */
export function createVercelDeployActions(actions: VercelActions): DeployProviderActions {
  return {
    async run(action: string, input: DeployActionInput): Promise<DeployActionResult> {
      switch (action) {
        case "redeploy": {
          // The caller reads the original first so the retry inherits its name
          // and target; without the target a production retry silently comes
          // back as a preview.
          const created = await actions.redeploy({
            uid: input.deploymentId,
            name: requireField(input.name, "name"),
            target: input.target ?? null,
          });
          return { deployment: { id: created.uid, url: created.url } };
        }
        case "cancel":
          await actions.cancel(input.deploymentId);
          return {};
        case "promote":
          await actions.promote(requireField(input.projectId, "projectId"), input.deploymentId);
          return {};
        case "rollback":
          await actions.rollback(
            requireField(input.projectId, "projectId"),
            input.deploymentId,
            input.description,
          );
          return {};
        default:
          throw new Error(`Vercel does not support the action "${action}".`);
      }
    },

    async createEnv(projectId, input) {
      return toProviderEnvVar(
        await actions.createEnv(projectId, {
          key: input.key,
          value: input.value,
          target: input.environments,
          type: input.type,
        }),
      );
    },
    async updateEnv(projectId, envId, input) {
      return toProviderEnvVar(
        await actions.updateEnv(projectId, envId, {
          value: input.value,
          target: input.environments,
        }),
      );
    },
    async deleteEnv(projectId, envId) {
      await actions.deleteEnv(projectId, envId);
    },
  };
}

function requireField(value: string | undefined, field: string): string {
  if (!value) throw new Error(`This action requires "${field}".`);
  return value;
}
