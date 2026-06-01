import { CheckCircle, Circle, RefreshCw, XCircle } from "lucide-react";
import type { GitHubWorkflowRun } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useGitHubActions } from "./hooks/use-github-actions";

export function ActionsView() {
  const { runs, loading, error, refresh } = useGitHubActions();

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <h2 className="text-[13px] font-semibold">Workflow Runs</h2>
        <Button
          disabled={loading}
          onClick={() => void refresh()}
          size="sm"
          type="button"
          variant="outline"
        >
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
          <ul className="divide-y divide-border">
            {runs.map((run) => (
              <li key={run.id}>
                <a
                  className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/60"
                  href={run.html_url}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  <RunStatusIcon run={run} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{run.name}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      #{run.run_number} · {run.head_branch} · {run.event} ·{" "}
                      {new Date(run.created_at).toLocaleDateString()}
                    </span>
                  </span>
                  <RunConclusionBadge run={run} />
                </a>
              </li>
            ))}
          </ul>
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

function RunConclusionBadge({ run }: { run: GitHubWorkflowRun }) {
  const label = run.status === "completed" ? (run.conclusion ?? "completed") : run.status;
  const colorClass =
    label === "success"
      ? "border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-emerald-400/30 dark:bg-emerald-500/15 dark:text-emerald-300"
      : label === "failure" || label === "timed_out"
        ? "border-red-200 bg-red-100 text-red-800 dark:border-red-400/30 dark:bg-red-500/15 dark:text-red-300"
        : label === "in_progress" || label === "queued"
          ? "border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-400/30 dark:bg-amber-500/15 dark:text-amber-300"
          : "border-border bg-muted/50 text-muted-foreground";
  return (
    <span className={`shrink-0 rounded border px-1.5 py-px text-[10px] font-medium ${colorClass}`}>
      {label}
    </span>
  );
}
