import type { ConfigStore } from "../config-store.js";
import { vercelDeployProvider } from "../vercel-context.js";
import type { ProviderAuthSpec, ProviderCredential } from "./credentials.js";
import type {
  DeployProvider,
  DeployProviderActions,
  DeployProviderHooks,
  DeployProviderManifest,
  ProviderProject,
} from "./deploy-provider.js";

/**
 * The in-tree provider registry.
 *
 * This is the file a new provider is added to, and — apart from its own
 * directory — the *only* one. That is the whole point of the exercise: adding
 * Cloudflare should not mean editing `server.ts`, `app.tsx`, `routes/index.ts`,
 * `mcp/tools/index.ts`, `en.ts`, `zh.ts` and `mock-api.ts` the way adding
 * Vercel did.
 *
 * Deliberately a static array rather than a loader. Third-party providers are
 * out of scope until three implementations have shaped the contract — see §7 of
 * `docs/plans/2026-08-13-provider-registry-design.md`.
 */

/** A connected provider client plus whatever project resolves for the repo. */
export interface ProviderContext {
  provider: DeployProvider;
  credential: ProviderCredential;
  /** Absent when connected but no project is linked to this repo yet. */
  project?: ProviderProject;
}

export interface RegisteredDeployProvider {
  manifest: DeployProviderManifest;
  auth: ProviderAuthSpec;
  hooks: DeployProviderHooks;
  /** Throws when the provider is not connected; a missing project does not. */
  context(configStore: ConfigStore, gitCwd: string): Promise<ProviderContext>;
  /** The write-capable half, resolved separately and never given to an MCP tool. */
  actions(configStore: ConfigStore): Promise<DeployProviderActions>;
}

export const deployProviders: RegisteredDeployProvider[] = [vercelDeployProvider];

export function findDeployProvider(id: string): RegisteredDeployProvider | undefined {
  return deployProviders.find((provider) => provider.manifest.id === id);
}

/** Throws with the id the caller asked for, which is what the route reports. */
export function requireDeployProvider(id: string): RegisteredDeployProvider {
  const provider = findDeployProvider(id);
  if (!provider) throw new Error(`Unknown provider "${id}".`);
  return provider;
}

export const deployProviderManifests = (): DeployProviderManifest[] =>
  deployProviders.map((provider) => provider.manifest);

/** A connected client for `providerId`, or a throw naming what is not connected. */
export function requireProviderContext(
  providerId: string,
  configStore: ConfigStore,
  gitCwd: string,
): Promise<ProviderContext> {
  return requireDeployProvider(providerId).context(configStore, gitCwd);
}

/** The same, for callers that treat "not connected" as "nothing to show". */
export async function optionalProviderContext(
  providerId: string,
  configStore: ConfigStore,
  gitCwd: string,
): Promise<ProviderContext | null> {
  try {
    return await requireProviderContext(providerId, configStore, gitCwd);
  } catch {
    return null;
  }
}

export function requireProviderActions(
  providerId: string,
  configStore: ConfigStore,
): Promise<DeployProviderActions> {
  return requireDeployProvider(providerId).actions(configStore);
}
