import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowDown, GitCommit, Loader2, Upload } from "lucide-react";
import {
  gitPush,
  listGitHubWorkflowRuns,
  type DashboardData,
  type GitHubWorkflowRun,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { AgentMark } from "../agent/ai-spark";
import { useAgentDock } from "../agent/chat/agent-context";
import {
  buildCommitDirtyPrompt,
  buildFixCiPrompt,
  buildPullRebasePrompt,
} from "../agent/prompts";

/**
 * Proactive git situation strip shown in the agent dock. Surfaces what's
 * actionable right now — uncommitted changes, ahead/behind upstream, a failing
 * CI run — and offers one-click actions. Push is deterministic; the rest hand a
 * scoped task to the agent. Renders nothing when the branch is clean and synced.
 */
export function GitSituationBanner({
  git,
  onRefresh,
}: {
  git: DashboardData["git"];
  onRefresh?: () => void;
}) {
  const { sendToAgent } = useAgentDock();
  const [pushing, setPushing] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [failingRun, setFailingRun] = useState<GitHubWorkflowRun | null>(null);

  const status = git.status;
  const branch = status?.branch || undefined;
  const dirtyCount = status?.files.length ?? 0;
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;

  // Best-effort CI lookup for the current branch's latest run. Silently skips
  // when there's no GitHub token / remote configured.
  useEffect(() => {
    if (!branch) {
      setFailingRun(null);
      return;
    }
    let active = true;
    void listGitHubWorkflowRuns(branch, 1)
      .then((runs) => {
        if (!active) return;
        const latest = runs[0];
        setFailingRun(latest && isFailedRun(latest) ? latest : null);
      })
      .catch(() => {
        if (active) setFailingRun(null);
      });
    return () => {
      active = false;
    };
  }, [branch]);

  const hasSituation = useMemo(
    () => dirtyCount > 0 || ahead > 0 || behind > 0 || !!failingRun,
    [dirtyCount, ahead, behind, failingRun],
  );

  if (!status || !hasSituation) return null;

  async function push() {
    setPushing(true);
    setPushError(null);
    try {
      await gitPush();
      onRefresh?.();
    } catch (caught) {
      setPushError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPushing(false);
    }
  }

  return (
    <div className="mx-auto mb-2 w-full max-w-4xl">
      <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-[11px]">
        <span className="mr-0.5 inline-flex items-center gap-1 font-medium text-muted-foreground">
          <AgentMark className="size-3.5" />
          {branch ?? "git"}
        </span>

        {dirtyCount > 0 ? (
          <Chip
            icon={<GitCommit className="size-3" />}
            label={`Commit ${dirtyCount} change${dirtyCount === 1 ? "" : "s"}`}
            ai
            onClick={() =>
              sendToAgent({
                prompt: buildCommitDirtyPrompt({ branch, fileCount: dirtyCount }),
                source: { type: "git-situation", label: "uncommitted changes" },
                mode: "send",
                label: `Commit ${dirtyCount} uncommitted change${dirtyCount === 1 ? "" : "s"}`,
              })
            }
          />
        ) : null}

        {behind > 0 ? (
          <Chip
            icon={<ArrowDown className="size-3" />}
            label={`Pull ${behind} behind`}
            ai
            onClick={() =>
              sendToAgent({
                prompt: buildPullRebasePrompt({ branch, behind, upstream: status.upstream }),
                source: { type: "git-situation", label: "behind upstream" },
                mode: "send",
                label: `Pull & rebase (${behind} behind)`,
              })
            }
          />
        ) : null}

        {ahead > 0 ? (
          <Chip
            icon={pushing ? <Loader2 className="size-3 animate-spin" /> : <Upload className="size-3" />}
            label={`Push ${ahead}`}
            disabled={pushing}
            onClick={() => void push()}
          />
        ) : null}

        {failingRun ? (
          <Chip
            danger
            icon={<AlertTriangle className="size-3" />}
            label="Fix failing CI"
            ai
            onClick={() =>
              sendToAgent({
                prompt: buildFixCiPrompt({
                  branch,
                  runName: failingRun.name,
                  url: failingRun.html_url,
                }),
                source: { type: "git-situation", label: "failing CI" },
                mode: "send",
                label: `Fix failing CI: ${failingRun.name}`,
              })
            }
          />
        ) : null}

        {pushError ? <span className="text-destructive">{pushError}</span> : null}
      </div>
    </div>
  );
}

function Chip({
  ai,
  danger,
  disabled,
  icon,
  label,
  onClick,
}: {
  ai?: boolean;
  danger?: boolean;
  disabled?: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium transition-colors disabled:opacity-50",
        danger
          ? "border-destructive/40 bg-destructive/5 text-destructive hover:bg-destructive/10"
          : "border-border bg-background text-foreground hover:bg-muted",
      )}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {icon}
      {label}
      {ai ? <AgentMark className="size-3 opacity-70" /> : null}
    </button>
  );
}

/** A finished workflow run that didn't succeed (failed, timed out, cancelled). */
function isFailedRun(run: GitHubWorkflowRun): boolean {
  return (
    run.status === "completed" &&
    run.conclusion !== null &&
    !["success", "neutral", "skipped"].includes(run.conclusion)
  );
}
