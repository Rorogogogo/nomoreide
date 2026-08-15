/**
 * This view's binding to the generic provider seam.
 *
 * Every call in `@/lib/api`'s provider surface takes a provider id first. This
 * file supplies it from React context, so the components below keep calling
 * `api.listDeployments()` with no id and the *same* component tree renders
 * Vercel, Cloudflare, or whatever lands in `core/providers/registry.ts` next.
 *
 * **Why the bound API is cached per id rather than rebuilt per render.** The
 * hooks below pass these functions straight into `useCallback`/`useEffect`
 * dependency arrays (see `hooks/use-provider-resource.ts`). A fresh closure on
 * every render would change identity every time and spin the effect forever, so
 * `providerApi(id)` must return the *same object* for the same id.
 */
import { createContext, useContext, useMemo } from "react";
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
import type { DeployCapability, ProviderApi, ProviderManifest } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";

/**
 * The provider selected when nothing is stored yet. Vercel only because it is
 * the one every existing user is already connected to — nothing else in this
 * directory treats it as special.
 */
export const DEFAULT_PROVIDER_ID = "vercel";

type Rest<F> = F extends (providerId: string, ...rest: infer R) => infer T
  ? (...args: R) => T
  : never;

/** The provider surface with its id already applied. */
export type BoundProviderApi = {
  [K in Exclude<keyof ProviderApi, "listProviders">]: Rest<ProviderApi[K]>;
};

function bindAll(providerId: string): BoundProviderApi {
  const bind = <K extends keyof ProviderApi>(
    method: ProviderApi[K],
  ): Rest<ProviderApi[K]> =>
    ((...args: unknown[]) =>
      (method as (...a: unknown[]) => unknown)(providerId, ...args)) as Rest<ProviderApi[K]>;

  return {
    getStatus: bind<"getStatus">(getProviderStatus),
    connect: bind<"connect">(connectProvider),
    startOAuth: bind<"startOAuth">(startProviderOAuth),
    getOAuthPhase: bind<"getOAuthPhase">(getProviderOAuthPhase),
    disconnect: bind<"disconnect">(disconnectProvider),
    setScope: bind<"setScope">(setProviderScope),
    listProjects: bind<"listProjects">(listProviderProjects),
    setProject: bind<"setProject">(setProviderProject),
    getProject: bind<"getProject">(getProviderProject),
    listEnv: bind<"listEnv">(listProviderEnv),
    getEnvValue: bind<"getEnvValue">(getProviderEnvValue),
    createEnv: bind<"createEnv">(createProviderEnv),
    updateEnv: bind<"updateEnv">(updateProviderEnv),
    deleteEnv: bind<"deleteEnv">(deleteProviderEnv),
    listDomains: bind<"listDomains">(listProviderDomains),
    listDeployments: bind<"listDeployments">(listProviderDeployments),
    getDeployment: bind<"getDeployment">(getProviderDeployment),
    getDeploymentLogs: bind<"getDeploymentLogs">(getProviderDeploymentLogs),
    getRuntimeLogs: bind<"getRuntimeLogs">(getProviderRuntimeLogs),
    runDeploymentAction: bind<"runDeploymentAction">(runProviderDeploymentAction),
  };
}

const bound = new Map<string, BoundProviderApi>();

/** The bound surface for `providerId`, stable across calls — see the file note. */
export function providerApi(providerId: string): BoundProviderApi {
  let api = bound.get(providerId);
  if (!api) {
    api = bindAll(providerId);
    bound.set(providerId, api);
  }
  return api;
}

export interface ProviderSelection {
  id: string;
  /**
   * Null until `/api/providers` has answered. Capability checks treat null as
   * "assume supported" so a tab does not flicker out and back in during the
   * first paint — see {@link useCapability}.
   */
  manifest: ProviderManifest | null;
}

const ProviderContext = createContext<ProviderSelection>({
  id: DEFAULT_PROVIDER_ID,
  manifest: null,
});

export const ProviderSelectionProvider = ProviderContext.Provider;

export function useProviderId(): string {
  return useContext(ProviderContext).id;
}

export function useProviderManifest(): ProviderManifest | null {
  return useContext(ProviderContext).manifest;
}

export function useProviderApi(): BoundProviderApi {
  const { id } = useContext(ProviderContext);
  return useMemo(() => providerApi(id), [id]);
}

/**
 * Whether the selected provider serves `capability`.
 *
 * This is the manifest field earning its keep: Cloudflare declares no
 * `runtimeLogs`, so the tab is hidden rather than shown and then erroring. An
 * unknown manifest returns true, because hiding a tab the provider does support
 * is the worse of the two wrong answers while the list is still loading.
 */
export function useCapability(capability: DeployCapability): boolean {
  const manifest = useProviderManifest();
  return manifest ? manifest.capabilities.includes(capability) : true;
}

/**
 * The provider's display name, for the host sentences that mention it.
 *
 * Several strings in `i18n/en.ts` are the host's own — one sentence for every
 * provider — but need the provider's name inside them ("Reconnect {name}").
 * Those stay in the catalogue and interpolate this; only strings whose *keys*
 * the provider determines move into the manifest.
 *
 * Falls back to the provider id, which is a recognisable word (`vercel`,
 * `cloudflare`) rather than a placeholder, so the sentence still reads if the
 * manifest has not arrived.
 */
export function useProviderName(): string {
  const { id, manifest } = useContext(ProviderContext);
  return manifest?.name ?? id;
}

/**
 * Resolve one of the provider's *own* strings — its action labels, their
 * toasts and confirmations, and what it calls a scope.
 *
 * The counterpart to `useT()`, and the split between them is the point of §11
 * gate item 2: `useT` holds the sentences the host writes once for every
 * provider ("No deployments yet."), while this holds the ones only the provider
 * can know, because it is the provider that decides `actions` and therefore
 * decides which keys exist. See `core/providers/strings.ts`.
 *
 * Falls back locale → English → `undefined`, so a caller can substitute
 * something better than a raw key: an action's own name reads acceptably on a
 * button, which is what a plugin missing `action.publish` gets.
 */
export function useProviderString(): (key: string) => string | undefined {
  const [language] = useLanguage();
  const manifest = useProviderManifest();
  return useMemo(() => {
    const strings = manifest?.strings;
    return (key: string) => strings?.[language]?.[key] ?? strings?.en[key];
  }, [manifest, language]);
}

/** What this provider calls a scope — "Team" for Vercel, "Account" for Cloudflare. */
export function useScopeLabel(): string | null {
  return useProviderString()("scope.label") ?? null;
}
