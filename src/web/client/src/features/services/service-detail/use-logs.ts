import { useEffect, useState } from "react";
import { getLogSourceLogs, getServiceLogs, type LogEntry, type LogQuery } from "@/lib/api";

/** Either a managed service's captured logs or a saved on-demand log source. */
export type LogTarget = { kind: "service" | "source"; name: string };

/** Stable string id for a target (used for dedupe and equality). */
export function encodeTarget(target: LogTarget): string {
  return `${target.kind}:${target.name}`;
}

/**
 * Polls a log target: every 1s while streaming, otherwise every 2s. The `query`
 * (time range, level, grep, paging) is pushed down to the host for both sources
 * and ssh journald/docker services; `queryable` reports whether the target can
 * actually re-query its host (vs. only exposing a live buffer).
 */
export function useLogs(target: LogTarget, streaming = false, query: LogQuery = {}) {
  const [logs, setLogs] = useState<LogEntry[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [queryable, setQueryable] = useState(target.kind === "source");

  // Depend on the query's stable signature so changes refetch without the
  // default {} object identity retriggering every render.
  const queryKey = JSON.stringify(query);

  useEffect(() => {
    setLogs(undefined);
    setError(undefined);
    let cancelled = false;
    const load = async () => {
      try {
        if (target.kind === "service") {
          const result = await getServiceLogs(target.name, query);
          if (!cancelled) {
            setLogs(result.logs);
            setQueryable(result.queryable);
            setError(undefined);
          }
        } else {
          const result = await getLogSourceLogs(target.name, query);
          if (!cancelled) {
            setLogs(result);
            setQueryable(true);
            setError(undefined);
          }
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      }
    };
    void load();
    const id = window.setInterval(load, streaming ? 1000 : 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [target.kind, target.name, streaming, queryKey]);

  return { logs, error, queryable };
}
