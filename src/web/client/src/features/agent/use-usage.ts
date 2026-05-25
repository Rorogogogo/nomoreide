import { useEffect, useState } from "react";
import { getAgentUsage, type UsageInfo } from "@/lib/api";

/** Polls token/cost + rate-limit usage for Claude Code and Codex on an interval. */
export function useUsage(pollMs = 10_000) {
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = () => {
      void getAgentUsage()
        .then((info) => {
          if (!active) return;
          setUsage(info);
          setError(null);
        })
        .catch((err: unknown) => {
          if (active) setError(err instanceof Error ? err.message : String(err));
        });
    };
    load();
    const interval = window.setInterval(load, pollMs);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [pollMs]);

  return { usage, error };
}
