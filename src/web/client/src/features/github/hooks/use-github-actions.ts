import { useEffect, useState } from "react";
import {
  listGitHubWorkflowRunJobs,
  listGitHubWorkflowRuns,
  type GitHubWorkflowJob,
  type GitHubWorkflowRun,
} from "@/lib/api";

// Mirrors the server's `per_page`; a full page back means there may be more.
const PAGE_SIZE = 30;

export function useGitHubActions(branch?: string) {
  const [runs, setRuns] = useState<GitHubWorkflowRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [jobs, setJobs] = useState<GitHubWorkflowJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobsError, setJobsError] = useState<string | null>(null);

  function load() {
    let active = true;
    setLoading(true);
    setError(null);
    setPage(1);
    void listGitHubWorkflowRuns(branch, 1)
      .then((next) => {
        if (!active) return;
        setRuns(next);
        setHasMore(next.length === PAGE_SIZE);
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }

  function loadMore() {
    if (loadingMore || !hasMore) return;
    const nextPage = page + 1;
    setLoadingMore(true);
    void listGitHubWorkflowRuns(branch, nextPage)
      .then((next) => {
        setRuns((prev) => {
          const seen = new Set(prev.map((r) => r.id));
          return [...prev, ...next.filter((r) => !seen.has(r.id))];
        });
        setHasMore(next.length === PAGE_SIZE);
        setPage(nextPage);
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setLoadingMore(false));
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [branch]);

  useEffect(() => {
    setSelectedRunId((current) => {
      if (current && runs.some((run) => run.id === current)) return current;
      return runs[0]?.id ?? null;
    });
  }, [runs]);

  useEffect(() => {
    if (!selectedRunId) {
      setJobs([]);
      return;
    }

    let active = true;
    setJobsLoading(true);
    setJobsError(null);
    void listGitHubWorkflowRunJobs(selectedRunId)
      .then((next) => { if (active) setJobs(next); })
      .catch((caught) => {
        if (active) setJobsError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => { if (active) setJobsLoading(false); });
    return () => { active = false; };
  }, [selectedRunId]);

  return {
    runs,
    selectedRunId,
    jobs,
    loading,
    loadingMore,
    hasMore,
    jobsLoading,
    error,
    jobsError,
    loadMore,
    refresh: load,
    setSelectedRunId,
  };
}
