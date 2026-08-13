import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ProviderDeployment,
  type ProviderProject,
} from "@/lib/api";
import {
  listVercelDeployments,
} from "../provider-client";

export type DeploymentFilter = "all" | "production" | "preview";

/** A build in one of these states is still moving, so the list keeps polling. */
const IN_FLIGHT = new Set(["building", "queued"]);
const POLL_MS = 8_000;

/**
 * The deployment list, self-refreshing while any build is in flight.
 *
 * Polling is conditional rather than on a fixed timer: an idle project makes
 * no requests at all, and a running build updates without the user reaching
 * for Refresh — which is the whole point of watching a deploy from here.
 */
export function useVercelDeployments(filter: DeploymentFilter, enabled = true) {
  const [deployments, setDeployments] = useState<ProviderDeployment[]>([]);
  const [project, setProject] = useState<ProviderProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(
    async (showSpinner: boolean) => {
      if (!enabled) return;
      const id = ++generation.current;
      if (showSpinner) setLoading(true);
      try {
        const res = await listVercelDeployments({
          target: filter === "all" ? undefined : filter,
        });
        if (id !== generation.current) return;
        setDeployments(res.deployments);
        setProject(res.project);
        setError(null);
      } catch (caught) {
        if (id !== generation.current) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (id === generation.current) setLoading(false);
      }
    },
    [filter, enabled],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  const hasInFlight = deployments.some((deployment) => IN_FLIGHT.has(deployment.state));
  useEffect(() => {
    if (!hasInFlight || !enabled) return;
    // Background refresh: no spinner, so the list updates under the user
    // rather than blanking out every few seconds while a build runs.
    const timer = setInterval(() => void load(false), POLL_MS);
    return () => clearInterval(timer);
  }, [hasInFlight, enabled, load]);

  return {
    deployments,
    project,
    loading,
    error,
    hasInFlight,
    refresh: useCallback(() => void load(true), [load]),
    /** For action handlers that want the list updated without a spinner. */
    refreshQuietly: useCallback(() => void load(false), [load]),
  };
}
