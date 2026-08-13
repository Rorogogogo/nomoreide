import type { ConfigStore } from "./config-store.js";
import type { ProviderContext, RegisteredDeployProvider } from "./providers/registry.js";
import {
  adoptSoleScope,
  resolveProviderProject,
} from "./providers/project-resolution.js";
import {
  resolveVercelCredential,
  VERCEL_AUTH,
  VERCEL_PROVIDER_ID,
  type ResolvedVercelCredential,
} from "./vercel-auth.js";
import { VercelActions } from "./vercel-actions.js";
import {
  createVercelDeployActions,
  createVercelDeployProvider,
  toProviderProject,
  VERCEL_HOOKS,
  VERCEL_MANIFEST,
} from "./vercel-provider.js";
import { VercelManager, type VercelProject } from "./vercel-manager.js";
import type { ProviderProject } from "./providers/deploy-provider.js";
import type { NoMoreIdeConfig } from "./types.js";

/**
 * Vercel's registry entry — how a connected client is built for a working
 * directory, and the write-capable half resolved separately from it.
 *
 * The registry imports this; this must not import the registry, or the two
 * would cycle.
 */

/** Persists a rotated token pair, which every credential resolution may produce. */
function persistTokens(configStore: ConfigStore) {
  return {
    onTokensRefreshed: (tokens: { accessToken: string; refreshToken?: string; expiresAt: number }) =>
      configStore
        .updateConnectionTokens(VERCEL_PROVIDER_ID, {
          token: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
        })
        .then(() => undefined),
  };
}

/**
 * A connected Vercel client for the given working directory.
 *
 * Throws when Vercel isn't connected — a missing *project* is not an error,
 * because the dashboard's job in that state is to help the user pick one.
 */
async function vercelContext(
  configStore: ConfigStore,
  gitCwd: string,
): Promise<ProviderContext> {
  const config = await configStore.load();
  const credential = await resolveVercelCredential(config, process.env, persistTokens(configStore));
  const identity = credential.source === "oauth" ? ("oidc" as const) : ("user" as const);
  const teamId =
    credential.scopeId ?? (await adoptDefaultTeam(configStore, credential, identity));
  const manager = new VercelManager(credential.token, teamId, undefined, { identity });
  return {
    provider: createVercelDeployProvider(manager),
    credential: { ...credential, scopeId: teamId },
    project: await resolveProject(config, manager, gitCwd),
  };
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

/** Write-capable counterpart, resolved the same way but returned separately. */
async function vercelActions(configStore: ConfigStore) {
  const config = await configStore.load();
  const credential = await resolveVercelCredential(config, process.env, persistTokens(configStore));
  return createVercelDeployActions(
    new VercelActions({ token: credential.token, teamId: credential.scopeId }),
  );
}

/**
 * Which Vercel project this repository deploys — the shared three-tier ladder,
 * given Vercel's own two hooks.
 */
async function resolveProject(
  config: NoMoreIdeConfig,
  manager: VercelManager,
  gitCwd: string,
): Promise<ProviderProject | undefined> {
  const project = await resolveProviderProject<VercelProject>({
    providerId: VERCEL_PROVIDER_ID,
    hooks: VERCEL_HOOKS,
    config,
    gitCwd,
    getProject: (id) => manager.getProject(id),
    findByRepoUrl: async (repoUrl) => (await manager.listProjects({ repoUrl, limit: 2 }))[0],
  });
  return project ? toProviderProject(project) : undefined;
}

export const vercelDeployProvider: RegisteredDeployProvider = {
  manifest: VERCEL_MANIFEST,
  auth: VERCEL_AUTH,
  hooks: VERCEL_HOOKS,
  context: vercelContext,
  actions: vercelActions,
};
