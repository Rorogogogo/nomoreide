import { useEffect, useState } from "react";
import { getServiceLogs, type LogEntry } from "@/lib/api";

/** Polls a service's recent logs every 2s while mounted. */
export function useServiceLogs(serviceName: string) {
  const [logs, setLogs] = useState<LogEntry[] | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const result = await getServiceLogs(serviceName);
        if (!cancelled) setLogs(result);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      }
    };
    void load();
    const id = window.setInterval(load, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [serviceName]);

  return { logs, error };
}
