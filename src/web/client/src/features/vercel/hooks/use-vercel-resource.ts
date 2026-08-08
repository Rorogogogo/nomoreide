import { useCallback, useEffect, useRef, useState } from "react";
import {
  getVercelProject,
  listVercelDeployments,
  listVercelDomains,
  listVercelEnv,
  type VercelDeployment,
  type VercelDomain,
  type VercelEnvVar,
  type VercelProject,
} from "@/lib/api";

/**
 * One-shot loader for the project-scoped tabs (env, domains, settings).
 *
 * Unlike {@link ./use-vercel-deployments} these never poll: an environment
 * variable or a domain changes when a human changes it, not while you watch, so
 * a timer here would only cost requests. Refresh is explicit, and wired to the
 * header's refresh button by the panel that mounts it.
 *
 * A generation counter, not an `active` flag, guards the writes — a refresh
 * fired while the first load is in flight would otherwise let the older
 * response land last.
 */
function useVercelResource<T>(fetcher: () => Promise<T>, empty: T) {
  const [data, setData] = useState<T>(empty);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
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
  }, [fetcher]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, loading, error, refresh: useCallback(() => void load(), [load]) };
}

export function useVercelEnv() {
  return useVercelResource<VercelEnvVar[]>(listVercelEnv, []);
}

export function useVercelDomains() {
  return useVercelResource<VercelDomain[]>(listVercelDomains, []);
}

export function useVercelProjectSettings() {
  return useVercelResource<VercelProject | null>(getVercelProject, null);
}

/**
 * The deployment currently serving production traffic, independent of
 * whatever filter the deployment list is showing — the production hero needs
 * this even while the list is scoped to "preview" and wouldn't otherwise
 * include it.
 */
async function fetchProductionDeployment() {
  const { deployments } = await listVercelDeployments({ target: "production", limit: 1 });
  return deployments[0] ?? null;
}

export function useVercelProductionDeployment() {
  return useVercelResource<VercelDeployment | null>(fetchProductionDeployment, null);
}
