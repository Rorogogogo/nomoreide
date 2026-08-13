import type { ConfigStore } from "./config-store.js";
import {
  adoptSoleScope,
  readLinkedProjectId as readProviderLinkedProjectId,
  resolveProviderProject,
} from "./providers/project-resolution.js";
import {
  resolveVercelCredential,
  VERCEL_PROVIDER_ID,
  type ResolvedVercelCredential,
} from "./vercel-auth.js";
import { VercelActions } from "./vercel-actions.js";
import { VERCEL_HOOKS } from "./vercel-provider.js";
import { VercelManager, type VercelProject } from "./vercel-manager.js";
import type { NoMoreIdeConfig } from "./types.js";

export interface VercelContext {
  manager: VercelManager;
  credential: ResolvedVercelCredential;
  /** Absent when connected but no project is linked to this repo yet. */
  project?: VercelProject;
}

/**
 * A connected Vercel client for the given working directory.
 *
 * Throws when Vercel isn't connected — a missing *project* is not an error,
 * because the dashboard's job in that state is to help the user pick one.
 */
export async function requireVercelContext(
  configStore: ConfigStore,
  gitCwd: string,
): Promise<VercelContext> {
  const config = await configStore.load();
  const credential = await resolveVercelCredential(config, process.env, {
    onTokensRefreshed: (tokens) =>
      configStore
        .updateConnectionTokens(VERCEL_PROVIDER_ID, {
          token: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
        })
        .then(() => undefined),
  });
  const identity = credential.source === "oauth" ? ("oidc" as const) : ("user" as const);
  const teamId =
    credential.scopeId ?? (await adoptDefaultTeam(configStore, credential, identity));
  const manager = new VercelManager(credential.token, teamId, undefined, { identity });
  const project = await resolveProject(config, manager, gitCwd);
  return { manager, credential: { ...credential, scopeId: teamId }, project };
}

/** The team scope to use when the user has never chosen one — see {@link adoptSoleScope}. */
function adoptDefaultTeam(
  configStore: ConfigStore,
  credential: ResolvedVercelCredential,
  identity: "user" | "oidc",
): Promise<string | undefined> {
  return adoptSoleScope({
    source: credential.source,
    listScopes: () =>
      new VercelManager(credential.token, undefined, undefined, { identity }).listTeams(),
    persist: (scope) =>
      configStore.setConnectionScope(VERCEL_PROVIDER_ID, scope).then(() => undefined),
  });
}

export async function optionalVercelContext(
  configStore: ConfigStore,
  gitCwd: string,
): Promise<VercelContext | null> {
  try {
    return await requireVercelContext(configStore, gitCwd);
  } catch {
    return null;
  }
}

/** Write-capable counterpart, resolved the same way but returned separately. */
export async function requireVercelActions(
  configStore: ConfigStore,
): Promise<VercelActions> {
  const config = await configStore.load();
  const credential = await resolveVercelCredential(config, process.env, {
    onTokensRefreshed: (tokens) =>
      configStore
        .updateConnectionTokens(VERCEL_PROVIDER_ID, {
          token: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
        })
        .then(() => undefined),
  });
  return new VercelActions({ token: credential.token, teamId: credential.scopeId });
}

/**
 * Which Vercel project this repository deploys — the shared three-tier ladder,
 * given Vercel's own two hooks. Still returns a `VercelProject` rather than the
 * neutral shape: the dashboard's wire format is unchanged until the routes move
 * to `/api/providers/:id/*`.
 */
function resolveProject(
  config: NoMoreIdeConfig,
  manager: VercelManager,
  gitCwd: string,
): Promise<VercelProject | undefined> {
  return resolveProviderProject<VercelProject>({
    providerId: VERCEL_PROVIDER_ID,
    hooks: VERCEL_HOOKS,
    config,
    gitCwd,
    getProject: (id) => manager.getProject(id),
    findByRepoUrl: async (repoUrl) =>
      (await manager.listProjects({ repoUrl, limit: 2 }))[0],
  });
}

/** `projectId` from `.vercel/project.json`, when the repo has been `vercel link`ed. */
export function readLinkedProjectId(repoRoot: string): Promise<string | undefined> {
  // biome-ignore lint/style/noNonNullAssertion: VERCEL_HOOKS declares a link file.
  return readProviderLinkedProjectId(repoRoot, VERCEL_HOOKS.linkFile!);
}

/** The working directory Vercel operations run against — mirrors the GitHub seam. */
export function selectedVercelCwd(config: NoMoreIdeConfig, fallbackCwd: string): string {
  const repository =
    config.gitRepositories.find((entry) => entry.name === config.selectedGitRepository)
    ?? config.gitRepositories[0];
  return repository?.activeWorktreePath ?? repository?.path ?? fallbackCwd;
}
