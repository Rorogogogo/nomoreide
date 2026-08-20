import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ProviderDeployment,
  ProviderDomain,
  ProviderEnvVar,
  ProviderProject,
} from "@/lib/api";
import { useProviderApi } from "../provider-client";

/**
 * One-shot loader for the project-scoped tabs (env, domains, settings).
 *
 * Unlike {@link ./use-provider-deployments} these never poll: an environment
 * variable or a domain changes when a human changes it, not while you watch, so
 * a timer here would only cost requests. Refresh is explicit, and wired to the
 * header's refresh button by the panel that mounts it.
 *
 * A generation counter, not an `active` flag, guards the writes — a refresh
 * fired while the first load is in flight would otherwise let the older
 * response land last.
 *
 * Switching providers is *not* handled here: the view remounts its subtree on
 * the provider id, which resets this state along with everything else. That is
 * why `fetcher` may be assumed stable for the lifetime of the hook.
 */
function useProviderResource<T>(fetcher: () => Promise<T>, empty: T, enabled = true) {
  const [data, setData] = useState<T>(empty);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    // A provider that does not declare the capability has no endpoint to call;
    // asking anyway would surface a 4xx as if the user had done something wrong.
    if (!enabled) {
      setLoading(false);
      return;
    }
    const id = ++generation.current;
    setLoading(true);
    try {
      const next = await fetcher();
      if (id !== generation.current) return;
      setData(next);
      setError(null);
    } catch (caught) {
      if (id !== generation.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (id === generation.current) setLoading(false);
    }
  }, [fetcher, enabled]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, loading, error, refresh: useCallback(() => void load(), [load]) };
}

export function useProviderEnv(enabled = true) {
  const api = useProviderApi();
  return useProviderResource<ProviderEnvVar[]>(api.listEnv, [], enabled);
}

export function useProviderDomains(enabled = true) {
  const api = useProviderApi();
  return useProviderResource<ProviderDomain[]>(api.listDomains, [], enabled);
}

export function useProviderProjectSettings() {
  const api = useProviderApi();
  return useProviderResource<ProviderProject | null>(api.getProject, null);
}

/**
 * The deployment currently serving production traffic, independent of
 * whatever filter the deployment list is showing — the production hero needs
 * this even while the list is scoped to "preview" and wouldn't otherwise
 * include it.
 */
export function useProviderProductionDeployment() {
  const api = useProviderApi();
  const fetcher = useCallback(async () => {
    const { deployments } = await api.listDeployments({ target: "production", limit: 1 });
    return deployments[0] ?? null;
  }, [api]);
  return useProviderResource<ProviderDeployment | null>(fetcher, null);
}
