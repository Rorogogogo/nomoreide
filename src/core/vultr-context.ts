import type { ConfigStore } from "./config-store.js";
import { resolveProviderCredential } from "./providers/credentials.js";
import type { HostContext, RegisteredHostProvider } from "./providers/registry.js";
import { VultrActions } from "./vultr-actions.js";
import { VULTR_AUTH } from "./vultr-auth.js";
import { VultrManager } from "./vultr-manager.js";
import {
  createVultrHostActions,
  createVultrHostProvider,
  VULTR_MANIFEST,
} from "./vultr-provider.js";

/**
 * Vultr's registry entry — how a connected client is built, and the
 * write-capable half resolved separately from it.
 *
 * The registry imports this; this must not import the registry, or the two
 * would cycle.
 *
 * Notably shorter than either deploy provider's counterpart, and the missing
 * parts are the interesting bit:
 *
 * - **No working directory.** An instance belongs to an account, not to a
 *   repository, so there is nothing to resolve against the git remote and no
 *   three-tier ladder to run.
 * - **No scope.** A Vultr API key addresses exactly one account and Vultr has
 *   no team to switch between, so `adoptSoleScope` has nothing to adopt.
 * - **No token persistence.** Vultr has no browser sign-in, so nothing here
 *   ever rotates a refresh token.
 *
 * What is left is the shared credential resolver and two factories, which is
 * the smallest a provider has been so far.
 */

async function vultrContext(configStore: ConfigStore): Promise<HostContext> {
  const config = await configStore.load();
  const credential = await resolveProviderCredential(VULTR_AUTH, config, process.env);
  return {
    provider: createVultrHostProvider(new VultrManager(credential.token)),
    credential,
  };
}

/** Write-capable counterpart, resolved the same way but returned separately. */
async function vultrActions(configStore: ConfigStore) {
  const config = await configStore.load();
  const credential = await resolveProviderCredential(VULTR_AUTH, config, process.env);
  return createVultrHostActions(new VultrActions({ token: credential.token }));
}

export const vultrHostProvider: RegisteredHostProvider = {
  manifest: VULTR_MANIFEST,
  auth: VULTR_AUTH,
  context: vultrContext,
  actions: vultrActions,
};
