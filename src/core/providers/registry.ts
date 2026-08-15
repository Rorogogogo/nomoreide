import { cloudflareDeployProvider } from "../cloudflare-context.js";
import type { ConfigStore } from "../config-store.js";
import { vercelDeployProvider } from "../vercel-context.js";
import { vultrHostProvider } from "../vultr-context.js";
import type { ProviderAuthSpec, ProviderCredential } from "./credentials.js";
import type {
  DeployProvider,
  DeployProviderActions,
  DeployProviderHooks,
  DeployProviderManifest,
  ProviderProject,
} from "./deploy-provider.js";
import type {
  HostProvider,
  HostProviderActions,
  HostProviderManifest,
} from "./host-provider.js";

/**
 * The in-tree provider registry.
 *
 * This is the file a new provider is added to, and — apart from its own
 * directory — the *only* one. That is the whole point of the exercise: adding
 * Cloudflare should not mean editing `server.ts`, `app.tsx`, `routes/index.ts`,
 * `mcp/tools/index.ts`, `en.ts`, `zh.ts` and `mock-api.ts` the way adding
 * Vercel did.
 *
 * Two kinds live here, because there are two contracts: deploy platforms
 * (`DeployProvider`) and infrastructure hosts (`HostProvider`). They share the
 * credential layer and nothing else, so they get separate arrays and separate
 * lookups rather than a union that every caller would have to narrow.
 *
 * Deliberately static arrays rather than a loader. Third-party providers are
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

export const deployProviders: RegisteredDeployProvider[] = [
  vercelDeployProvider,
  cloudflareDeployProvider,
];

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

// --- Host providers ---

/**
 * A connected host client. Deliberately has no project and no working
 * directory: an instance belongs to an account, not to a repository, which is
 * the shape difference that made this a second contract rather than a wider
 * first one.
 */
export interface HostContext {
  provider: HostProvider;
  credential: ProviderCredential;
}

export interface RegisteredHostProvider {
  manifest: HostProviderManifest;
  auth: ProviderAuthSpec;
  /** Throws when the provider is not connected. */
  context(configStore: ConfigStore): Promise<HostContext>;
  /** The write-capable half, resolved separately and never given to an MCP tool. */
  actions(configStore: ConfigStore): Promise<HostProviderActions>;
}

export const hostProviders: RegisteredHostProvider[] = [vultrHostProvider];

export function findHostProvider(id: string): RegisteredHostProvider | undefined {
  return hostProviders.find((provider) => provider.manifest.id === id);
}

/** Throws with the id the caller asked for, which is what the route reports. */
export function requireHostProvider(id: string): RegisteredHostProvider {
  const provider = findHostProvider(id);
  if (!provider) throw new Error(`Unknown host provider "${id}".`);
  return provider;
}

export const hostProviderManifests = (): HostProviderManifest[] =>
  hostProviders.map((provider) => provider.manifest);

export function requireHostContext(
  providerId: string,
  configStore: ConfigStore,
): Promise<HostContext> {
  return requireHostProvider(providerId).context(configStore);
}

export function requireHostActions(
  providerId: string,
  configStore: ConfigStore,
): Promise<HostProviderActions> {
  return requireHostProvider(providerId).actions(configStore);
}
