import { isValidElement, useEffect, useState, type ReactNode } from "react";
import { GitBranch } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import type { DashboardData, GitHubWorkflowRun, UsageInfo } from "@/lib/api";
import { useT, type Translate } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { fetchLatestWorkflowRun } from "../../github/latest-action-cache";
import { useUsage } from "../use-usage";

/** A rate-limit window from either provider — the two agree on this shape. */
interface RateWindow {
  usedPercent: number;
  resetsAtUnix: number;
}

/** The provider-agnostic slice of usage the strip actually renders. */
interface PickedUsage {
  fiveHour?: RateWindow;
  /** Share of the context window consumed last turn (Codex only), 0–100. */
  contextPercent: number | null;
  /** Last-session spend in USD (Claude only). */
  costUSD: number | null;
}

/**
 * Reduce the raw usage payload to what the strip shows, preferring whichever
 * provider the user is actually driving (falling back to the one with data).
 */
function pickUsage(usage: UsageInfo | null, provider?: string): PickedUsage | null {
  const { claude, codex } = usage ?? {};
  const codexView = codex
    ? {
        fiveHour: codex.primary,
        contextPercent:
          codex.contextWindow && codex.contextWindow > 0
            ? Math.min(100, (codex.lastTotalTokens / codex.contextWindow) * 100)
            : null,
        costUSD: null,
      }
    : null;
  const claudeView = claude
    ? {
        fiveHour: claude.fiveHour,
        contextPercent: null,
        costUSD: claude.costUSD,
      }
    : null;
  // Codex wins when it's the active provider (or the only one with data).
  if (provider === "codex" && codexView) return codexView;
  return claudeView ?? codexView ?? null;
}

/** Poll the newest Actions run on the selected repository's current branch. */
function useLatestAction(git?: DashboardData["git"]): GitHubWorkflowRun | null {
  const repo = git?.selectedRepository?.name ?? null;
  const branch = git?.status?.branch ?? null;
  const [run, setRun] = useState<GitHubWorkflowRun | null>(null);

  useEffect(() => {
    if (!repo) {
      setRun(null);
      return;
    }
    setRun(null);
    let active = true;
    const load = () =>
      fetchLatestWorkflowRun(repo, branch ?? undefined)
        .then((latest) => {
          if (active) setRun(latest);
        })
        .catch(() => {
          // Keep the last good result through transient GitHub errors.
        });
    load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [repo, branch]);

  return run;
}

function toneFor(pct: number): string {
  return pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500";
}

type ActionState = "pending" | "success" | "failure" | "error";

export function actionState(run: GitHubWorkflowRun): ActionState {
  if (run.status !== "completed") return "pending";
  if (
    run.conclusion === "success" ||
    run.conclusion === "neutral" ||
    run.conclusion === "skipped"
  ) {
    return "success";
  }
  if (
    run.conclusion === "failure" ||
    run.conclusion === "timed_out" ||
    run.conclusion === "cancelled"
  ) {
    return "failure";
  }
  return "error";
}

function actionDot(state: ActionState): string {
  switch (state) {
    case "success":
      return "bg-emerald-500";
    case "pending":
      return "bg-amber-400 animate-pulse";
    case "failure":
      return "bg-red-500";
    case "error":
      return "bg-orange-500";
    default:
      return "bg-zinc-400";
  }
}

function limitTitle(t: Translate, label: string, window: RateWindow): string {
  const base = t("dock.status.limitTitle", { label, pct: window.usedPercent.toFixed(0) });
  if (!window.resetsAtUnix) return base;
  const time = new Date(window.resetsAtUnix * 1000).toLocaleString();
  return `${base}${t("dock.status.resetsSuffix", { time })}`;
}

/** One rate-limit meter: label + thin bar + percentage, all display-only. */
function LimitMeter({
  label,
  window: window_,
  className,
}: {
  label: string;
  window: RateWindow;
  className?: string;
}) {
  const t = useT();
  const pct = Math.min(100, Math.max(0, window_.usedPercent));
  return (
    <span
      className={cn("flex items-center gap-1 font-mono text-[10px] text-muted-foreground", className)}
      title={limitTitle(t, label, window_)}
    >
      <span>{label}</span>
      <span className="h-1.5 w-7 overflow-hidden rounded-full bg-muted">
        <span className={cn("block h-full", toneFor(pct))} style={{ width: `${pct.toFixed(0)}%` }} />
      </span>
      <span className="tabular-nums text-foreground">{pct.toFixed(0)}%</span>
    </span>
  );
}

function StatItem({
  title,
  className,
  children,
}: {
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn("flex items-center gap-1 font-mono text-[10px] text-muted-foreground", className)}
      title={title}
    >
      {children}
    </span>
  );
}

function Divider() {
  return <span aria-hidden className="h-3 w-px shrink-0 bg-border" />;
}

function LatestActionItem({
  onOpen,
  run,
  variant,
}: {
  onOpen?: (branch: string) => void;
  run: GitHubWorkflowRun;
  variant: "strip" | "dock" | "side";
}) {
  const t = useT();
  const state = actionState(run);
  const updated = new Date(run.updated_at).toLocaleString();
  const stateLabel = t(`dock.status.actionState.${state}`);

  return (
    <Tooltip
      label={
        <span className="block min-w-52 space-y-1 whitespace-normal text-left">
          <span className="flex items-center justify-between gap-3">
            <span className="font-semibold">{run.name}</span>
            <span>{stateLabel}</span>
          </span>
          <span className="block font-mono text-[10px] opacity-75">
            {t("dock.status.actionMeta", {
              branch: run.head_branch,
              number: run.run_number,
            })}
          </span>
          <span className="block text-[10px] opacity-75">
            {state === "pending"
              ? t("dock.status.actionRunning")
              : t("dock.status.actionLatest")}{" "}
            · {t("dock.status.actionUpdated", { time: updated })}
          </span>
        </span>
      }
      side={variant === "strip" ? "top" : variant === "side" ? "left" : "bottom"}
    >
      <button
        aria-label={t("dock.status.openAction", { name: run.name, number: run.run_number })}
        className="pointer-events-auto hidden max-w-36 items-center gap-1 rounded-sm font-mono text-[10px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:flex"
        onClick={() => onOpen?.(run.head_branch)}
        type="button"
      >
        <span className={cn("size-2 shrink-0 rounded-full", actionDot(state))} />
        <span className="truncate">{t("dock.status.actions")}</span>
      </button>
    </Tooltip>
  );
}

/**
 * Glanceable status cluster for the agent dock: current branch + ahead/behind,
 * latest GitHub Actions status, the 5-hour rate-limit meter, and the active
 * session's context/cost.
 *
 * `variant` tunes density: "strip" (the collapsed bar) shows everything as room
 * allows; "dock" (the open terminal's tab row) keeps only the compact limits +
 * Actions status so it never crowds the tabs.
 */
export function DockStatusStrip({
  git,
  onOpenActions,
  provider,
  variant = "strip",
}: {
  git?: DashboardData["git"];
  onOpenActions?: (branch: string) => void;
  provider?: string;
  variant?: "strip" | "dock" | "side";
}) {
  const t = useT();
  const { usage } = useUsage(15_000);
  const latestAction = useLatestAction(git);
  const picked = pickUsage(usage, provider);

  const status = git?.status ?? null;
  const upstream = status?.upstream ?? t("dock.status.noUpstream");
  const showBranch = variant === "strip" && !!status?.branch;
  const showContext =
    variant === "strip" && (picked?.contextPercent != null || picked?.costUSD != null);

  const items: ReactNode[] = [];

  if (showBranch && status) {
    items.push(
      <StatItem
        className="hidden max-w-[9rem] md:flex"
        key="branch"
        title={t("dock.status.branchTitle", { branch: status.branch, upstream })}
      >
        <GitBranch className="size-3 shrink-0" />
        <span className="truncate text-foreground">{status.branch}</span>
        {status.ahead > 0 ? <span className="text-emerald-600">↑{status.ahead}</span> : null}
        {status.behind > 0 ? <span className="text-amber-600">↓{status.behind}</span> : null}
      </StatItem>,
    );
  }

  if (latestAction) {
    items.push(
      <LatestActionItem
        key="action"
        onOpen={onOpenActions}
        run={latestAction}
        variant={variant}
      />,
    );
  }

  // Only the 5-hour window. The weekly one moves too slowly to be worth a
  // permanent slot in the bar — the usage card still breaks both down.
  if (picked?.fiveHour) {
    items.push(<LimitMeter key="5h" label={t("dock.status.fiveHour")} window={picked.fiveHour} />);
  }

  if (showContext && picked) {
    if (picked.contextPercent != null) {
      items.push(
        <StatItem
          className="hidden lg:flex"
          key="ctx"
          title={t("dock.status.contextTitle", { pct: picked.contextPercent.toFixed(0) })}
        >
          <span>{t("dock.status.context")}</span>
          <span className="tabular-nums text-foreground">{picked.contextPercent.toFixed(0)}%</span>
        </StatItem>,
      );
    } else if (picked.costUSD != null) {
      items.push(
        <StatItem
          className="hidden lg:flex"
          key="cost"
          title={t("dock.status.costTitle", { cost: `$${picked.costUSD.toFixed(4)}` })}
        >
          <span className="tabular-nums text-emerald-700 dark:text-emerald-500">
            ${picked.costUSD.toFixed(2)}
          </span>
        </StatItem>,
      );
    }
  }

  if (items.length === 0) return null;

  // Join items with hairline dividers; a leading divider separates the whole
  // cluster from whatever sits to its left (the task label or capability chips).
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-2",
        variant === "dock" && "hidden px-2 lg:flex",
        variant === "side" && "min-w-max px-2",
      )}
    >
      {variant !== "side" ? <Divider /> : null}
      {items.map((item, index) => (
        <span
          className="flex items-center gap-2"
          key={isValidElement(item) ? item.key : String(item)}
        >
          {index > 0 ? <Divider /> : null}
          {item}
        </span>
      ))}
    </span>
  );
}
