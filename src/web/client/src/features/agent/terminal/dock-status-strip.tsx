import { useEffect, useState, type ReactNode } from "react";
import { GitBranch } from "lucide-react";
import type { CommitCIStatus, DashboardData, UsageInfo } from "@/lib/api";
import { getGitGraph } from "@/lib/api";
import { useT, type Translate } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { fetchCiStatus } from "../../github/ci-status-cache";
import { useUsage } from "../use-usage";

/** A rate-limit window from either provider — the two agree on this shape. */
interface RateWindow {
  usedPercent: number;
  resetsAtUnix: number;
}

/** The provider-agnostic slice of usage the strip actually renders. */
interface PickedUsage {
  fiveHour?: RateWindow;
  weekly?: RateWindow;
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
        weekly: codex.secondary,
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
        weekly: claude.weekly,
        contextPercent: null,
        costUSD: claude.costUSD,
      }
    : null;
  // Codex wins when it's the active provider (or the only one with data).
  if (provider === "codex" && codexView) return codexView;
  return claudeView ?? codexView ?? null;
}

/** Resolve the selected repo's HEAD sha, then poll its CI status. */
function useHeadCi(git?: DashboardData["git"]): CommitCIStatus | null {
  const repo = git?.selectedRepository?.name ?? null;
  const branch = git?.status?.branch ?? null;
  const ahead = git?.status?.ahead ?? 0;
  const [sha, setSha] = useState<string | null>(null);
  const [ci, setCi] = useState<CommitCIStatus | null>(null);

  // Re-resolve the HEAD sha whenever the repo, branch, or commit count moves.
  useEffect(() => {
    if (!repo) {
      setSha(null);
      return;
    }
    let active = true;
    getGitGraph(1)
      .then((commits) => {
        if (active) setSha(commits[0]?.hash ?? null);
      })
      .catch(() => {
        if (active) setSha(null);
      });
    return () => {
      active = false;
    };
  }, [repo, branch, ahead]);

  // Poll CI for that sha; the shared cache dedupes and lets "pending" refresh.
  useEffect(() => {
    if (!sha) {
      setCi(null);
      return;
    }
    let active = true;
    const load = () =>
      fetchCiStatus(sha)
        .then((status) => {
          if (active) setCi(status);
        })
        .catch(() => {
          if (active) setCi(null);
        });
    load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [sha]);

  return ci;
}

function toneFor(pct: number): string {
  return pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500";
}

function ciDot(state: CommitCIStatus["state"]): string {
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

/**
 * Glanceable status cluster for the agent dock: current branch + ahead/behind,
 * HEAD CI status, the 5-hour and weekly rate-limit meters, and the active
 * session's context/cost. Every element is a display-only span so the whole
 * cluster can live inside the collapsed strip's button without nesting.
 *
 * `variant` tunes density: "strip" (the collapsed bar) shows everything as room
 * allows; "dock" (the open terminal's tab row) keeps only the compact limits +
 * CI so it never crowds the tabs.
 */
export function DockStatusStrip({
  git,
  provider,
  variant = "strip",
}: {
  git?: DashboardData["git"];
  provider?: string;
  variant?: "strip" | "dock";
}) {
  const t = useT();
  const { usage } = useUsage(15_000);
  const ci = useHeadCi(git);
  const picked = pickUsage(usage, provider);

  const status = git?.status ?? null;
  const upstream = status?.upstream ?? t("dock.status.noUpstream");
  const showCi = ci && ci.state !== "unknown" && ci.totalCount > 0;
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

  if (showCi && ci) {
    items.push(
      <StatItem
        className="hidden sm:flex"
        key="ci"
        title={t("dock.status.ciTitle", { state: ci.state, count: ci.totalCount })}
      >
        <span className={cn("size-2 shrink-0 rounded-full", ciDot(ci.state))} />
        <span>{t("dock.status.ci")}</span>
      </StatItem>,
    );
  }

  if (picked?.fiveHour) {
    items.push(<LimitMeter key="5h" label={t("dock.status.fiveHour")} window={picked.fiveHour} />);
  }
  if (picked?.weekly) {
    items.push(
      <LimitMeter
        className="hidden sm:flex"
        key="wk"
        label={t("dock.status.weekly")}
        window={picked.weekly}
      />,
    );
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
          title={t("dock.status.costTitle", { cost: picked.costUSD.toFixed(4) })}
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
        variant === "dock" && "hidden border-l border-border px-2 lg:flex",
      )}
    >
      {variant === "strip" ? <Divider /> : null}
      {items.map((item, index) => (
        <span className="flex items-center gap-2" key={index}>
          {index > 0 ? <Divider /> : null}
          {item}
        </span>
      ))}
    </span>
  );
}
