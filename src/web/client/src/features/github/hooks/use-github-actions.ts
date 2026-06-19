import { useCallback, useEffect, useState } from "react";
import {
  listGitHubWorkflowRunJobs,
  listGitHubWorkflowRuns,
  type GitHubWorkflowJob,
  type GitHubWorkflowRun,
} from "@/lib/api";

// Mirrors the server's `per_page`; a full page back means there may be more.
const PAGE_SIZE = 30;
// While a run is queued/in-progress we poll this fast so the run status *and*
// its job/step detail feel live, instead of looking frozen until completion.
const ACTIVE_POLL_MS = 4000;

function isLive(run: GitHubWorkflowRun): boolean {
  return run.status === "in_progress" || run.status === "queued";
}

// Signatures of just the fields that drive the UI, so a poll that returns
// identical data can short-circuit the state update and avoid re-rendering the
// runs list / job-step detail every few seconds (the "keeps refreshing" flicker).
function runsSignature(runs: GitHubWorkflowRun[]): string {
  return runs.map((run) => `${run.id}:${run.status}:${run.conclusion}`).join("|");
}

function jobsSignature(jobs: GitHubWorkflowJob[]): string {
  return jobs
    .map(
      (job) =>
        `${job.id}:${job.status}:${job.conclusion}:` +
        job.steps.map((step) => `${step.number}:${step.status}:${step.conclusion}`).join(","),
    )
    .join("|");
}

/**
 * Non-destructive merge of a fresh page-1 fetch into the runs already on screen:
 * updates the status/conclusion of runs we still have, prepends brand-new ones,
 * and leaves older paged-in history intact. Used by the silent sync so a poll
 * (or the header Refresh) never collapses pagination back to page 1.
 */
function mergeRuns(
  prev: GitHubWorkflowRun[],
  fresh: GitHubWorkflowRun[],
): GitHubWorkflowRun[] {
  if (prev.length === 0) return fresh;
  const freshById = new Map(fresh.map((run) => [run.id, run]));
  const seen = new Set(prev.map((run) => run.id));
  const brandNew = fresh.filter((run) => !seen.has(run.id));
  const updated = prev.map((run) => freshById.get(run.id) ?? run);
  return [...brandNew, ...updated];
}

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

  // Silent refresh: reload the latest runs and the selected run's jobs without
  // toggling any spinner or resetting pagination. Drives both the header Refresh
  // and the live poll below, so the job/step detail keeps up with a running pipeline.
  const syncLatest = useCallback(() => {
    void listGitHubWorkflowRuns(branch, 1)
      .then((next) =>
        setRuns((prev) => {
          const merged = mergeRuns(prev, next);
          // Keep the old reference when nothing changed so React skips the re-render.
          return runsSignature(prev) === runsSignature(merged) ? prev : merged;
        }),
      )
      .catch(() => { /* transient; the next tick (or manual refresh) retries */ });
    if (selectedRunId) {
      void listGitHubWorkflowRunJobs(selectedRunId)
        .then((next) =>
          setJobs((prev) => (jobsSignature(prev) === jobsSignature(next) ? prev : next)),
        )
        .catch(() => { /* keep the last good jobs view */ });
    }
  }, [branch, selectedRunId]);

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

  // Poll fast only while something is actually running, and only when the tab is
  // visible. It stops on its own once every run reaches a terminal state, so an
  // idle Actions view falls back to the slower whole-dashboard refresh.
  const hasLiveRun = runs.some(isLive);
  useEffect(() => {
    if (!hasLiveRun) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") syncLatest();
    }, ACTIVE_POLL_MS);
    return () => window.clearInterval(id);
  }, [hasLiveRun, syncLatest]);

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
    syncLatest,
    setSelectedRunId,
  };
}
