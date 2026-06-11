import { CheckCircle, Circle, ExternalLink, RefreshCw, X, XCircle } from "lucide-react";
import type { GitHubWorkflowJob, GitHubWorkflowJobStep, GitHubWorkflowRun } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useGitHubActions } from "./hooks/use-github-actions";
import { LoadMoreButton } from "./load-more-button";

export function ActionsView({
  branch,
  onClearBranch,
}: {
  branch?: string;
  onClearBranch?: () => void;
}) {
  const {
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
    refresh,
    setSelectedRunId,
  } = useGitHubActions(branch);
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold">Workflow Runs</h2>
          {branch ? (
            <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="shrink-0">Filtered to</span>
              <span className="min-w-0 truncate font-mono">{branch}</span>
              {onClearBranch ? (
                <button
                  aria-label="Clear branch filter"
                  className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  onClick={onClearBranch}
                  title="Clear branch filter"
                  type="button"
                >
                  <X className="size-3" />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        <Button disabled={loading} onClick={() => void refresh()} size="sm" type="button" variant="outline">
          <RefreshCw className={`mr-1 size-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="p-4 text-[12px] text-red-500">{error}</div>
        ) : loading && runs.length === 0 ? (
          <div className="p-4 text-[12px] text-muted-foreground">Loading workflow runs…</div>
        ) : runs.length === 0 ? (
          <div className="p-4 text-[12px] text-muted-foreground">No workflow runs found.</div>
        ) : (
          <div className="grid h-full min-h-0 grid-cols-[minmax(280px,380px)_minmax(0,1fr)] divide-x divide-border">
            <div className="min-h-0 overflow-auto">
            <ul className="divide-y divide-border">
              {runs.map((run) => (
                <li key={run.id}>
                  <button
                    className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/60 ${
                      run.id === selectedRunId ? "bg-muted/70" : ""
                    }`}
                    onClick={() => setSelectedRunId(run.id)}
                    type="button"
                  >
                    <RunStatusIcon run={run} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{run.name}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        #{run.run_number} · {run.head_branch} · {run.event} ·{" "}
                        {new Date(run.created_at).toLocaleDateString()}
                      </span>
                    </span>
                    <RunConclusionStatus run={run} />
                  </button>
                </li>
              ))}
            </ul>
            <LoadMoreButton hasMore={hasMore} loading={loadingMore} onLoadMore={loadMore} />
            </div>

            <RunJobsDetail
              error={jobsError}
              jobs={jobs}
              loading={jobsLoading}
              run={selectedRun}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function RunStatusIcon({ run }: { run: GitHubWorkflowRun }) {
  if (run.status === "in_progress" || run.status === "queued") {
    return <Circle className="size-4 shrink-0 animate-pulse text-amber-400" />;
  }
  if (run.conclusion === "success") {
    return <CheckCircle className="size-4 shrink-0 text-emerald-500" />;
  }
  if (run.conclusion === "failure" || run.conclusion === "timed_out") {
    return <XCircle className="size-4 shrink-0 text-red-500" />;
  }
  return <Circle className="size-4 shrink-0 text-zinc-400" />;
}

function RunConclusionStatus({ run }: { run: GitHubWorkflowRun }) {
  const label = run.status === "completed" ? (run.conclusion ?? "completed") : run.status;
  const colorClass =
    label === "success"
      ? "bg-emerald-500"
      : label === "failure" || label === "timed_out"
        ? "bg-red-500"
        : label === "in_progress" || label === "queued"
          ? "bg-amber-500"
          : "bg-muted-foreground";
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
      <span className={`size-1.5 rounded-full ${colorClass}`} />
      {label}
    </span>
  );
}

function RunJobsDetail({
  run,
  jobs,
  loading,
  error,
}: {
  run: GitHubWorkflowRun | null;
  jobs: GitHubWorkflowJob[];
  loading: boolean;
  error: string | null;
}) {
  if (!run) {
    return <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">Select a workflow run</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold">{run.name}</span>
          <span className="block text-[11px] text-muted-foreground">
            Run #{run.run_number} · {run.head_branch} · {run.head_sha.slice(0, 7)}
          </span>
        </span>
        <a
          aria-label="Open run on GitHub"
          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          href={run.html_url}
          rel="noopener noreferrer"
          target="_blank"
          title="Open run on GitHub"
        >
          <ExternalLink className="size-3.5" />
        </a>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="p-4 text-[12px] text-red-500">{error}</div>
        ) : loading ? (
          <div className="p-4 text-[12px] text-muted-foreground">Loading jobs…</div>
        ) : jobs.length === 0 ? (
          <div className="p-4 text-[12px] text-muted-foreground">No jobs found for this run.</div>
        ) : (
          <ul className="divide-y divide-border">
            {jobs.map((job) => (
              <li className="px-3 py-3" key={job.id}>
                <div className="mb-2 flex items-center gap-2">
                  <JobStatusIcon item={job} />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{job.name}</span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    {durationLabel(job.started_at, job.completed_at)}
                  </span>
                  <a
                    aria-label={`Open ${job.name} job on GitHub`}
                    className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    href={job.html_url}
                    rel="noopener noreferrer"
                    target="_blank"
                    title="Open job on GitHub"
                  >
                    <ExternalLink className="size-3.5" />
                  </a>
                </div>
                {job.steps.length ? (
                  <ol className="space-y-1.5 pl-6">
                    {job.steps.map((step) => (
                      <li className="flex items-center gap-2 text-[12px]" key={`${job.id}:${step.number}`}>
                        <JobStatusIcon item={step} />
                        <span className="min-w-0 flex-1 truncate">{step.name}</span>
                        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                          {durationLabel(step.started_at, step.completed_at)}
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="pl-6 text-[12px] text-muted-foreground">No step details available.</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function JobStatusIcon({ item }: { item: Pick<GitHubWorkflowJob | GitHubWorkflowJobStep, "status" | "conclusion"> }) {
  if (item.status === "in_progress" || item.status === "queued") {
    return <Circle className="size-3.5 shrink-0 animate-pulse text-amber-400" />;
  }
  if (item.conclusion === "success" || item.conclusion === "skipped") {
    return <CheckCircle className="size-3.5 shrink-0 text-emerald-500" />;
  }
  if (item.conclusion === "failure" || item.conclusion === "timed_out" || item.conclusion === "cancelled") {
    return <XCircle className="size-3.5 shrink-0 text-red-500" />;
  }
  return <Circle className="size-3.5 shrink-0 text-zinc-400" />;
}

function durationLabel(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return "-";
  const start = Date.parse(startedAt);
  const end = completedAt ? Date.parse(completedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "-";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}
