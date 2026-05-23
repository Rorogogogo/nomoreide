import { useCallback, useEffect, useState } from "react";
import { getErrorIncidents, type ErrorIncident } from "@/lib/api";

function sortNewestFirst(items: ErrorIncident[]): ErrorIncident[] {
  return [...items].sort((a, b) =>
    a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : b.id - a.id,
  );
}

/**
 * Live incident feed: seeds from `/api/errors`, then merges streamed updates
 * from the `/api/errors/stream` SSE endpoint. Incidents are kept newest-first
 * by `lastSeen`, replacing earlier copies of the same id (count/excerpt grow).
 */
export function useErrorIncidents() {
  const [incidents, setIncidents] = useState<ErrorIncident[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upsert = useCallback((incoming: ErrorIncident) => {
    setIncidents((prev) =>
      sortNewestFirst([...prev.filter((item) => item.id !== incoming.id), incoming]),
    );
  }, []);

  useEffect(() => {
    let active = true;
    void getErrorIncidents()
      .then((items) => {
        if (active) setIncidents(sortNewestFirst(items));
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      });

    const source = new EventSource("/api/errors/stream");
    source.addEventListener("open", () => setConnected(true));
    source.addEventListener("error", () => setConnected(false));
    source.addEventListener("incident", (event) => {
      try {
        const incident = JSON.parse((event as MessageEvent).data) as ErrorIncident;
        upsert(incident);
      } catch {
        // ignore malformed events
      }
    });

    return () => {
      active = false;
      source.close();
    };
  }, [upsert]);

  return { incidents, connected, error };
}
