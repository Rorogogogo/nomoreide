import { useEffect, useState } from "react";
import { listAgentTranscripts, type AgentTranscriptInfo } from "@/lib/api";

/** Provider history includes conversations launched outside the dock. */
export function useObservedAgentSessions() {
  const [sessions, setSessions] = useState<AgentTranscriptInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [observedAt, setObservedAt] = useState(Date.now);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await listAgentTranscripts("all");
        if (disposed) return;
        setSessions(next);
        setObservedAt(Date.now());
        setError(null);
      } catch (caught) {
        if (disposed) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!disposed) {
          setLoaded(true);
          timer = setTimeout(() => void refresh(), 15_000);
        }
      }
    }
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);

  return { sessions, error, loaded, observedAt };
}
