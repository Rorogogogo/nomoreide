import { useEffect, useRef, useState } from "react";
import {
  listAgentEnvRegistryProfiles,
  type AgentEnvRegistryProfileSort,
  type AgentEnvRegistryProfileSummary,
} from "@/lib/api";

const SEARCH_DEBOUNCE_MS = 250;

/** Searchable public registry catalog, loaded only while its panel is active. */
export function useRegistryProfiles(active: boolean) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<AgentEnvRegistryProfileSort>("recent");
  const [profiles, setProfiles] = useState<AgentEnvRegistryProfileSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const requestId = useRef(0);

  useEffect(() => {
    if (!active) return;
    const currentRequest = ++requestId.current;
    const delay = query.trim().length > 0 ? SEARCH_DEBOUNCE_MS : 0;
    setLoading(true);
    setError(null);
    setProfiles([]);
    const timer = window.setTimeout(() => {
      void listAgentEnvRegistryProfiles({ query, sort })
        .then((nextProfiles) => {
          if (requestId.current === currentRequest) setProfiles(nextProfiles);
        })
        .catch((caught) => {
          if (requestId.current !== currentRequest) return;
          setError(caught instanceof Error ? caught.message : String(caught));
        })
        .finally(() => {
          if (requestId.current === currentRequest) setLoading(false);
        });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [active, query, retryVersion, sort]);

  return {
    error,
    loading,
    profiles,
    query,
    retry: () => setRetryVersion((version) => version + 1),
    setQuery,
    setSort,
    sort,
  };
}
