import { GitBranch, GitPullRequest } from "lucide-react";
import type { ProjectGitHubSummary, ProjectGitSummary, ProjectVercelSummary } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn, formatRelativeTime } from "@/lib/utils";
import { DeploymentStateIcon } from "../vercel/deployment-state-badge";

/**
 * The per-domain body of an overview card.
 *
 * Each one answers a single question at a glance — "is this checked out
 * cleanly", "is anything red or waiting on me", "is production healthy" — so
 * they stay one dense line rather than becoming small dashboards.
 */

export function GitCard({ overview }: { overview?: ProjectGitSummary }) {
  const t = useT();
  if (!overview) return <Empty />;

  return (
    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground">
      <span className="flex min-w-0 items-center gap-1">
        <GitBranch className="size-3 shrink-0" />
        <span className="truncate font-mono">{overview.branch || t("overview.detached")}</span>
      </span>
      {overview.dirty > 0 ? (
        <span className="text-amber-500">{t("overview.dirty", { count: overview.dirty })}</span>
      ) : (
        <span className="text-emerald-500">{t("overview.clean")}</span>
      )}
      {overview.ahead > 0 ? <span>↑{overview.ahead}</span> : null}
      {overview.behind > 0 ? <span>↓{overview.behind}</span> : null}
    </span>
  );
}

export function GitHubCard({ overview }: { overview?: ProjectGitHubSummary }) {
  const t = useT();
  if (!overview) return <Empty />;

  return (
    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground">
      <span className="min-w-0 truncate font-mono">
        {overview.owner}/{overview.repo}
      </span>
      <span className="flex items-center gap-1">
        <GitPullRequest className="size-3 shrink-0" />
        {t("overview.openPrs", { count: overview.openPullRequests })}
      </span>
      {overview.checks ? (
        <span
          className={cn(
            overview.checks === "success" && "text-emerald-500",
            overview.checks === "failure" && "text-red-500",
            overview.checks === "pending" && "text-amber-500",
          )}
        >
          {t(`overview.checks.${overview.checks}`)}
        </span>
      ) : null}
    </span>
  );
}

export function VercelCard({ overview }: { overview?: ProjectVercelSummary }) {
  const t = useT();
  if (!overview) return <Empty />;

  return (
    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground">
      <span className="min-w-0 truncate font-mono">{overview.projectName}</span>
      {overview.state ? (
        <span className="flex items-center gap-1">
          <DeploymentStateIcon className="size-3" state={overview.state} />
        </span>
      ) : (
        <span>{t("overview.neverDeployed")}</span>
      )}
      {overview.createdAt ? (
        <span>{formatRelativeTime(new Date(overview.createdAt).toISOString())}</span>
      ) : null}
    </span>
  );
}

function Empty() {
  const t = useT();
  return <span className="text-[11px] text-muted-foreground">{t("overview.noData")}</span>;
}
