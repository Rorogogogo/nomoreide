import { useEffect, useState } from "react";
import {
  listGitHubWorkflowRunJobs,
  listGitHubWorkflowRuns,
  type GitHubWorkflowJob,
  type GitHubWorkflowRun,
} from "@/lib/api";

export function useGitHubActions(branch?: string) {
  const [runs, setRuns] = useState<GitHubWorkflowRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [jobs, setJobs] = useState<GitHubWorkflowJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobsError, setJobsError] = useState<string | null>(null);

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
    jobsLoading,
    error,
    jobsError,
    refresh: load,
    setSelectedRunId,
  };
}
