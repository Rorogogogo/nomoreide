import { useEffect } from "react";
import { ExternalLink } from "lucide-react";
import type { GitHubWorkflowJob, GitHubWorkflowJobStep, GitHubWorkflowRun } from "@/lib/api";
import { Loading } from "@/components/ui/loading";
import { useRegisterRefresh } from "@/components/refresh-registry";
import { useT } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/utils";
import { AiContextTarget } from "../agent/context-menu/ai-context-menu";
import { buildFixRunPrompt } from "../agent/prompts";
import { useGitHubActions } from "./hooks/use-github-actions";
import { LoadMoreButton } from "./load-more-button";
import {
  CheckCircleFill,
  DotCircleFill,
  RunningRing,
  SkipCircle,
  XCircleFill,
} from "./status-octicons";

/** A finished run that didn't succeed — the rows that get an AI "fix" affordance. */
function isFailedRun(run: GitHubWorkflowRun): boolean {
  return (
    run.conclusion === "failure" ||
    run.conclusion === "timed_out" ||
    run.conclusion === "cancelled"
  );
}

export function ActionsView({
  branch,
  onCountChange,
}: {
  branch?: string;
  /** Reports the row count so the page's tab row can show it — this view has
      no header bar of its own, and the app header already owns Refresh. */
  onCountChange?: (count: number | null) => void;
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
    syncLatest,
    setSelectedRunId,
  } = useGitHubActions(branch);
  const t = useT();
  // The header Refresh (and the poll) merge a fresh page-1 fetch in place, so
  // paged-in history survives a refresh. That is the only reload path now: the
  // panel's own button did a full reset nobody was asking for.
  useRegisterRefresh(syncLatest);

  useEffect(() => {
    onCountChange?.(loading && runs.length === 0 ? null : runs.length);
  }, [loading, onCountChange, runs.length]);
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? null;
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="p-4 text-[12px] text-red-500">{error}</div>
        ) : loading && runs.length === 0 ? (
          <Loading fill label={t("github.actions.loadingRuns")} />
        ) : runs.length === 0 ? (
          <div className="p-4 text-[12px] text-muted-foreground">{t("github.actions.noRuns")}</div>
        ) : (
          <div className="grid h-full min-h-0 grid-rows-2 divide-y divide-border @min-[640px]/workspace:grid-cols-[minmax(240px,0.55fr)_minmax(0,0.45fr)] @min-[640px]/workspace:grid-rows-1 @min-[640px]/workspace:divide-x @min-[640px]/workspace:divide-y-0">
            <div className="min-h-0 overflow-auto">
            <ul className="divide-y divide-border">
              {runs.map((run) => (
                <AiContextTarget
                  key={run.id}
                  target={{
                    label: `${run.name} #${run.run_number}`,
                    intents: isFailedRun(run) ? [{
                      id: "fix-run",
                      label: t("github.actions.fixRunAi", { number: run.run_number }),
                      resolvePrompt: () => buildFixRunPrompt(run),
                      source: {
                        type: "github-run",
                        label: t("github.actions.runLabel", { number: run.run_number }),
                      },
                      agentLabel: t("github.actions.runInputLabel", {
                        number: run.run_number,
                        input: t("github.actions.fixDefault"),
                      }),
                    }] : [],
                  }}
                >
                <li className="group flex flex-col">
                  <div
                    className={`flex items-center transition-colors hover:bg-muted/20 ${
                      run.id === selectedRunId ? "bg-muted/45" : ""
                    }`}
                  >
                    <button
                      aria-current={run.id === selectedRunId || undefined}
                      className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      onClick={() => setSelectedRunId(run.id)}
                      type="button"
                    >
                      <RunStatusIcon run={run} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium">{run.name}</span>
                        <span className="block text-[11px] text-muted-foreground">
                          #{run.run_number} · {run.head_branch} · {run.event} ·{" "}
                          <span title={new Date(run.created_at).toLocaleString()}>
                            {formatRelativeTime(run.created_at)}
                          </span>
                        </span>
                      </span>
                      <RunConclusionStatus run={run} />
                    </button>
                  </div>
                </li>
                </AiContextTarget>
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
  if (run.status === "in_progress") {
    return <RunningRing className="size-4 shrink-0 text-amber-400" />;
  }
  // Queued is genuinely waiting, not working — a spinner there would claim
  // progress that hasn't started.
  if (run.status === "queued") {
    return <DotCircleFill className="size-4 shrink-0 animate-pulse text-amber-400" />;
  }
  if (run.conclusion === "success") {
    return <CheckCircleFill className="size-4 shrink-0 text-emerald-500" />;
  }
  if (run.conclusion === "failure" || run.conclusion === "timed_out") {
    return <XCircleFill className="size-4 shrink-0 text-red-500" />;
  }
  if (run.conclusion === "skipped" || run.conclusion === "cancelled") {
    return <SkipCircle className="size-4 shrink-0 text-zinc-400" />;
  }
  return <DotCircleFill className="size-4 shrink-0 text-zinc-400" />;
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
  const t = useT();
  if (!run) {
    return <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">{t("github.actions.selectRun")}</div>;
  }

  return (
    <AiContextTarget
      target={{
        label: `${run.name} #${run.run_number}`,
        intents: isFailedRun(run) ? [{
          id: "fix-run",
          label: t("github.actions.fixWithAi"),
          resolvePrompt: () => buildFixRunPrompt(run),
          source: {
            type: "github-run",
            label: t("github.actions.runLabel", { number: run.run_number }),
          },
          agentLabel: t("github.actions.runInputLabel", {
            number: run.run_number,
            input: t("github.actions.fixDefault"),
          }),
        }] : [],
      }}
    >
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold">{run.name}</span>
          <span className="block text-[11px] text-muted-foreground">
            Run #{run.run_number} · {run.head_branch} · {run.head_sha.slice(0, 7)}
          </span>
        </span>
        <a
          aria-label={t("github.actions.openRun")}
          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          href={run.html_url}
          rel="noopener noreferrer"
          target="_blank"
          title={t("github.actions.openRun")}
        >
          <ExternalLink className="size-3.5" />
        </a>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="p-4 text-[12px] text-red-500">{error}</div>
        ) : loading ? (
          <Loading fill label={t("github.actions.loadingJobs")} />
        ) : jobs.length === 0 ? (
          <div className="p-4 text-[12px] text-muted-foreground">{t("github.actions.noJobs")}</div>
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
                    aria-label={t("github.actions.openJobAria", { name: job.name })}
                    className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    href={job.html_url}
                    rel="noopener noreferrer"
                    target="_blank"
                    title={t("github.actions.openJob")}
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
                  <p className="pl-6 text-[12px] text-muted-foreground">{t("github.actions.noSteps")}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
    </AiContextTarget>
  );
}

function JobStatusIcon({ item }: { item: Pick<GitHubWorkflowJob | GitHubWorkflowJobStep, "status" | "conclusion"> }) {
  if (item.status === "in_progress") {
    return <RunningRing className="size-3.5 shrink-0 text-amber-400" />;
  }
  if (item.status === "queued") {
    return <DotCircleFill className="size-3.5 shrink-0 animate-pulse text-amber-400" />;
  }
  if (item.conclusion === "success") {
    return <CheckCircleFill className="size-3.5 shrink-0 text-emerald-500" />;
  }
  if (item.conclusion === "failure" || item.conclusion === "timed_out") {
    return <XCircleFill className="size-3.5 shrink-0 text-red-500" />;
  }
  // Skipped was showing a green check and cancelled a red X — one overstated a
  // step that never ran, the other made an aborted run look broken.
  if (item.conclusion === "skipped" || item.conclusion === "cancelled") {
    return <SkipCircle className="size-3.5 shrink-0 text-zinc-400" />;
  }
  return <DotCircleFill className="size-3.5 shrink-0 text-zinc-400" />;
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
