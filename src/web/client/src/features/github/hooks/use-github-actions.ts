import { useEffect, useState } from "react";
import { listGitHubWorkflowRuns, type GitHubWorkflowRun } from "@/lib/api";

export function useGitHubActions(branch?: string) {
  const [runs, setRuns] = useState<GitHubWorkflowRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function load() {
    let active = true;
    setLoading(true);
    setError(null);
    void listGitHubWorkflowRuns(branch)
      .then((next) => { if (active) setRuns(next); })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [branch]);

  return { runs, loading, error, refresh: load };
}
