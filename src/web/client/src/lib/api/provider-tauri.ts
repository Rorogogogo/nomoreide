/**
 * Rust-core implementation of {@link ProviderApi}, over Tauri `invoke()` (desktop).
 *
 * The Rust core predates the provider registry and speaks Vercel's own shapes —
 * `uid`, uppercase states, `target` on env vars, seven build-setting fields. It
 * is also Vercel-only. So this adapter does two jobs the HTTP one does not:
 * it refuses any other provider id, and it normalizes Vercel's shapes into the
 * neutral contract on the way through.
 *
 * That normalization is exactly what a seam is for. Porting the Rust core to
 * the neutral shapes would remove it, but the desktop build is the one runtime
 * CI does not compile on a PR, so the conversion lives on this side where a
 * type error is caught by `npm run build`.
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
  ProviderApi,
  ProviderDeployment,
  ProviderDeploymentDetail,
  ProviderDeploymentState,
  ProviderDomain,
  ProviderEnvVar,
  ProviderLogLine,
  ProviderManifest,
  ProviderOAuthPhase,
  ProviderProject,
  ProviderStatusInfo,
} from "./provider-api.js";

/** The only provider the desktop core implements. */
const VERCEL = "vercel";

const VERCEL_MANIFEST: ProviderManifest = {
  id: VERCEL,
  name: "Vercel",
  kind: "deploy",
  scopeLabel: "Team",
  capabilities: ["projects", "deployments", "buildLogs", "runtimeLogs", "env", "domains"],
  actions: ["redeploy", "cancel", "promote", "rollback"],
  productionAffecting: ["promote", "rollback"],
};

function requireVercel(providerId: string): void {
  if (providerId !== VERCEL) {
    throw new Error(`${providerId} is not available in desktop mode.`);
  }
}

// --- Vercel's own shapes, as the Rust core still returns them ---

interface RawProject {
  id: string;
  name: string;
  framework?: string | null;
  updatedAt?: number;
  link?: { type: string; org?: string; repo?: string; productionBranch?: string };
  buildCommand?: string | null;
  devCommand?: string | null;
  installCommand?: string | null;
  outputDirectory?: string | null;
  rootDirectory?: string | null;
  nodeVersion?: string | null;
  serverlessFunctionRegion?: string | null;
}

interface RawDeployment {
  uid: string;
  name: string;
  url: string | null;
  state: string;
  target: string | null;
  createdAt: number;
  readyAt?: number;
  isCurrentProduction?: boolean;
  creator?: { username?: string; email?: string };
  meta: { branch?: string; sha?: string; commitMessage?: string; commitAuthor?: string };
  inspectorUrl?: string;
  aliases?: string[];
  buildingAt?: number;
  errorMessage?: string;
}

interface RawEnvVar {
  id: string;
  key: string;
  target: string[];
  type: string;
  gitBranch?: string | null;
  comment?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

interface RawBuildLogLine {
  id: string;
  createdAt: number;
  type: string;
  text: string;
}

interface RawRuntimeLogLine {
  id: string;
  createdAt: number;
  level: string;
  message: string;
  source?: string;
  statusCode?: number;
  requestMethod?: string;
  requestPath?: string;
}

const SETTINGS: { key: keyof RawProject; label: string }[] = [
  { key: "buildCommand", label: "Build command" },
  { key: "devCommand", label: "Dev command" },
  { key: "installCommand", label: "Install command" },
  { key: "outputDirectory", label: "Output directory" },
  { key: "rootDirectory", label: "Root directory" },
  { key: "nodeVersion", label: "Node version" },
  { key: "serverlessFunctionRegion", label: "Function region" },
];

const STATES: Record<string, ProviderDeploymentState> = {
  QUEUED: "queued",
  INITIALIZING: "building",
  BUILDING: "building",
  READY: "ready",
  ERROR: "error",
  CANCELED: "canceled",
  BLOCKED: "blocked",
  DELETED: "deleted",
};

function toProject(project: RawProject): ProviderProject {
  return {
    id: project.id,
    name: project.name,
    framework: project.framework,
    updatedAt: project.updatedAt,
    link: project.link,
    // Absent means "not read"; null means "framework default". Only the former
    // is dropped, exactly as `vercel-provider.ts` does on the server.
    settings: SETTINGS.filter(({ key }) => project[key] !== undefined).map(({ key, label }) => ({
      key: String(key),
      label,
      value: typeof project[key] === "string" ? (project[key] as string) : null,
    })),
  };
}

function toDeployment(deployment: RawDeployment): ProviderDeployment {
  return {
    id: deployment.uid,
    name: deployment.name,
    url: deployment.url,
    state: STATES[deployment.state] ?? "queued",
    rawState: deployment.state,
    target: deployment.target,
    createdAt: deployment.createdAt,
    readyAt: deployment.readyAt,
    isCurrentProduction: deployment.isCurrentProduction,
    creator: deployment.creator,
    meta: deployment.meta ?? {},
    inspectorUrl: deployment.inspectorUrl,
  };
}

function toEnvVar(env: RawEnvVar): ProviderEnvVar {
  return {
    id: env.id,
    key: env.key,
    environments: env.target ?? [],
    type: env.type,
    gitBranch: env.gitBranch,
    comment: env.comment,
    createdAt: env.createdAt,
    updatedAt: env.updatedAt,
  };
}

export const tauriProviderApi: ProviderApi = {
  async listProviders() {
    return [VERCEL_MANIFEST];
  },

  async getStatus(providerId) {
    requireVercel(providerId);
    const raw = (await tauri_vercelStatus()) as Record<string, unknown> & {
      project?: RawProject;
      teams?: ProviderStatusInfo["scopes"];
      teamId?: string;
      connection?: { teamId?: string; teamSlug?: string; source: string; username?: string };
    };
    return {
      ...(raw as unknown as ProviderStatusInfo),
      provider: VERCEL_MANIFEST,
      connection: raw.connection
        ? {
            source: raw.connection.source as "cli" | "stored" | "oauth",
            scopeId: raw.connection.teamId,
            scopeSlug: raw.connection.teamSlug,
            username: raw.connection.username,
          }
        : undefined,
      scopes: raw.teams,
      scopeId: raw.teamId,
      project: raw.project ? toProject(raw.project) : undefined,
    };
  },

  async connect(providerId, input) {
    requireVercel(providerId);
    await tauri_vercelConnect(input.source, input.source === "stored" ? input.token : undefined);
  },

  async startOAuth(providerId) {
    requireVercel(providerId);
    const res = await tauri_vercelOAuthStart();
    return { url: res.url };
  },

  async getOAuthPhase(providerId) {
    requireVercel(providerId);
    return (await tauri_vercelOAuthPhase()) as ProviderOAuthPhase;
  },

  async disconnect(providerId) {
    requireVercel(providerId);
    await tauri_vercelDisconnect();
  },

  async setScope(providerId, scope) {
    requireVercel(providerId);
    await tauri_vercelSetScope(scope.scopeId, scope.scopeSlug);
  },

  async listProjects(providerId, search) {
    requireVercel(providerId);
    const res = (await tauri_vercelListProjects(search)) as {
      projects?: RawProject[];
      linkedProjectId?: string | null;
    };
    return {
      projects: (res.projects ?? []).map(toProject),
      linkedProjectId: res.linkedProjectId ?? undefined,
    };
  },

  async setProject(providerId, projectId) {
    requireVercel(providerId);
    await tauri_vercelSetProject(projectId);
  },

  async getProject(providerId) {
    requireVercel(providerId);
    return toProject((await tauri_vercelGetProject()) as RawProject);
  },

  async listEnv(providerId) {
    requireVercel(providerId);
    return (((await tauri_vercelListEnv()) ?? []) as RawEnvVar[]).map(toEnvVar);
  },

  async getEnvValue(providerId, id) {
    requireVercel(providerId);
    return (await tauri_vercelEnvValue(id)).value;
  },

  async createEnv() {
    throw new Error("Adding an environment variable is not supported in desktop mode");
  },

  async updateEnv() {
    throw new Error("Editing an environment variable is not supported in desktop mode");
  },

  async deleteEnv() {
    throw new Error("Deleting an environment variable is not supported in desktop mode");
  },

  async listDomains(providerId) {
    requireVercel(providerId);
    return ((await tauri_vercelListDomains()) ?? []) as ProviderDomain[];
  },

  async listDeployments(providerId, opts = {}) {
    requireVercel(providerId);
    const res = (await tauri_vercelListDeployments(opts.target, opts.limit)) as {
      deployments?: RawDeployment[];
      project?: RawProject | null;
    };
    return {
      deployments: (res.deployments ?? []).map(toDeployment),
      project: res.project ? toProject(res.project) : null,
    };
  },

  async getDeployment(providerId, id) {
    requireVercel(providerId);
    const raw = (await tauri_vercelGetDeployment(id)) as RawDeployment;
    return {
      ...toDeployment(raw),
      aliases: raw.aliases ?? [],
      buildingAt: raw.buildingAt,
      errorMessage: raw.errorMessage,
    } satisfies ProviderDeploymentDetail;
  },

  async getDeploymentLogs(providerId, id, limit) {
    requireVercel(providerId);
    const raw = ((await tauri_vercelDeploymentLogs(id, limit)) ?? []) as RawBuildLogLine[];
    return raw.map<ProviderLogLine>((line) => ({
      id: line.id,
      createdAt: line.createdAt,
      kind: "build",
      level: line.type,
      text: line.text,
    }));
  },

  async getRuntimeLogs(providerId, id, limit) {
    requireVercel(providerId);
    const raw = ((await tauri_vercelRuntimeLogs(id, limit)) ?? []) as RawRuntimeLogLine[];
    return raw.map<ProviderLogLine>((line) => ({
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
    }));
  },

  async runDeploymentAction(providerId, id, action) {
    requireVercel(providerId);
    const res = await tauri_vercelDeploymentAction(id, action);
    return {
      deployment: res.deployment
        ? { id: res.deployment.uid, url: res.deployment.url }
        : undefined,
    };
  },
};
