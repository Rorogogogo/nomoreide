import { CloudflareActions } from "./cloudflare-actions.js";
import type { ConfigStore } from "./config-store.js";
import { CLOUDFLARE_AUTH, CLOUDFLARE_PROVIDER_ID } from "./cloudflare-auth.js";
import { CloudflareManager, type CloudflareProject } from "./cloudflare-manager.js";
import {
  CLOUDFLARE_HOOKS,
  CLOUDFLARE_MANIFEST,
  createCloudflareDeployActions,
  createCloudflareDeployProvider,
  toProviderProject,
} from "./cloudflare-provider.js";
import { resolveProviderCredential, type ProviderCredential } from "./providers/credentials.js";
import type { ProviderProject } from "./providers/deploy-provider.js";
import {
  adoptSoleScope,
  resolveProviderProject,
} from "./providers/project-resolution.js";
import type { ProviderContext, RegisteredDeployProvider } from "./providers/registry.js";
import type { NoMoreIdeConfig } from "./types.js";

/**
 * Cloudflare's registry entry — how a connected client is built for a working
 * directory, and the write-capable half resolved separately from it.
 *
 * The registry imports this; this must not import the registry, or the two
 * would cycle.
 *
 * Shorter than Vercel's counterpart in one place and longer in another, which
 * is the point of doing provider #2 before publishing anything:
 *
 * - **No token persistence.** Cloudflare has no browser sign-in, so nothing
 *   here ever rotates a refresh token — the `onTokensRefreshed` plumbing Vercel
 *   needs is simply absent.
 * - **The account is resolved before the project, not after.** Every Pages path
 *   contains an account id, so project resolution cannot even begin until the
 *   scope is known.
 */

/**
 * A connected Cloudflare client for the given working directory.
 *
 * Throws when Cloudflare isn't connected. A missing *account* is not an error
 * either: `account()` and `listScopes()` answer without one, which is what lets
 * the dashboard show the account switcher rather than a dead end.
 */
async function cloudflareContext(
  configStore: ConfigStore,
  gitCwd: string,
): Promise<ProviderContext> {
  const config = await configStore.load();
  const credential = await resolveProviderCredential(CLOUDFLARE_AUTH, config, process.env);
  const accountId = credential.scopeId ?? (await adoptDefaultAccount(configStore, credential));
  const manager = new CloudflareManager(credential.token, accountId);
  const project = await resolveProject(config, manager, gitCwd);
  return {
    // The project is resolved first and handed to the provider: Cloudflare has
    // no global deployment endpoint, so the deployment reads need it.
    provider: createCloudflareDeployProvider(manager, project?.name),
    credential: { ...credential, scopeId: accountId },
    project,
  };
}

/**
 * The account to use when the user has never chosen one.
 *
 * `cliSelectsScope: false` because Wrangler has no account switch to inherit —
 * so unlike Vercel, a `cli` credential does adopt the sole account, or a
 * `wrangler login` with one account could never read a single project. It is
 * still not written to config, so `CLOUDFLARE_ACCOUNT_ID` keeps winning.
 */
function adoptDefaultAccount(
  configStore: ConfigStore,
  credential: ProviderCredential,
): Promise<string | undefined> {
  return adoptSoleScope({
    source: credential.source,
    cliSelectsScope: false,
    listScopes: () =>
      new CloudflareManager(credential.token).listAccounts().then((accounts) =>
        // Cloudflare accounts have no slug; the id addresses one.
        accounts.map((account) => ({ id: account.id, slug: account.id })),
      ),
    persist: (scope) =>
      configStore.setConnectionScope(CLOUDFLARE_PROVIDER_ID, scope).then(() => undefined),
  });
}

/** Write-capable counterpart, resolved the same way but returned separately. */
async function cloudflareActions(configStore: ConfigStore) {
  const config = await configStore.load();
  const credential = await resolveProviderCredential(CLOUDFLARE_AUTH, config, process.env);
  const accountId = credential.scopeId ?? (await adoptDefaultAccount(configStore, credential));
  if (!accountId) {
    throw new Error("Choose a Cloudflare account before changing one of its projects.");
  }
  return createCloudflareDeployActions(
    new CloudflareActions({ token: credential.token }, accountId),
  );
}

/**
 * Which Cloudflare project this repository deploys — the shared three-tier
 * ladder, with only two of its three tiers in play: Wrangler writes no link
 * file, so an unpinned repo is matched on its git remote.
 */
async function resolveProject(
  config: NoMoreIdeConfig,
  manager: CloudflareManager,
  gitCwd: string,
): Promise<ProviderProject | undefined> {
  const project = await resolveProviderProject<CloudflareProject>({
    providerId: CLOUDFLARE_PROVIDER_ID,
    hooks: CLOUDFLARE_HOOKS,
    config,
    gitCwd,
    getProject: (id) => manager.getProject(id),
    findByRepoUrl: (repoUrl) => manager.findProjectByRepo(repoUrl),
  });
  return project ? toProviderProject(project) : undefined;
}

export const cloudflareDeployProvider: RegisteredDeployProvider = {
  manifest: CLOUDFLARE_MANIFEST,
  auth: CLOUDFLARE_AUTH,
  hooks: CLOUDFLARE_HOOKS,
  context: cloudflareContext,
  actions: cloudflareActions,
};
