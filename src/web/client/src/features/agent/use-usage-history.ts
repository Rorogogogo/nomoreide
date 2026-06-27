import { useCallback, useEffect, useState } from "react";
import { getAgentUsageHistory, type UsageHistoryResult } from "@/lib/api";

/** Polls the persisted token/cost history + aggregate summary. */
export function useUsageHistory(pollMs = 30_000) {
  const [data, setData] = useState<UsageHistoryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setData(await getAgentUsageHistory());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), pollMs);
    return () => window.clearInterval(interval);
  }, [refresh, pollMs]);

  return { data, error, loading, refresh };
}
