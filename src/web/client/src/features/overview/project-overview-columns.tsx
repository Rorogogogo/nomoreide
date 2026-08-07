import type { ReactNode } from "react";
import { GitBranch, GitPullRequest } from "lucide-react";
import type {
  OverviewDomain,
  ProjectGitHubSummary,
  ProjectGitSummary,
  ProjectOverviewEntry,
  ProjectVercelSummary,
} from "@/lib/api";
import { useT, type TranslationKey } from "@/lib/i18n";
import { cn, formatRelativeTime } from "@/lib/utils";
import { DeploymentStateBadge } from "../vercel/deployment-state-badge";
import { VercelLogo } from "../vercel/vercel-logo";
import { GitHubLogo } from "../github/github-logo";

/**
 * The columns of the all-projects table, per domain.
 *
 * Each domain answers a single question at a glance — "is this checked out
 * cleanly", "is anything red or waiting on me", "is production healthy". The
 * header and every row share one grid template so those answers land in the
 * same place on every line and the eye can run down a column.
 */

/**
 * Grid template per domain. Spelled out as whole class strings because
 * Tailwind scans source text — a template assembled at runtime produces no CSS.
 */
export const DOMAIN_TEMPLATES: Record<OverviewDomain, string> = {
  git: "grid-cols-[minmax(0,1.5fr)_minmax(0,1.4fr)_minmax(0,0.9fr)_4.5rem]",
  github: "grid-cols-[minmax(0,1.5fr)_minmax(0,1.6fr)_minmax(0,0.8fr)_minmax(0,0.8fr)]",
  vercel: "grid-cols-[minmax(0,1.5fr)_minmax(0,1.4fr)_minmax(0,1fr)_5.5rem]",
};

export const DOMAIN_HEADERS: Record<OverviewDomain, TranslationKey[]> = {
  git: [
    "overview.column.project",
    "overview.column.branch",
    "overview.column.status",
    "overview.column.sync",
  ],
  github: [
    "overview.column.project",
    "overview.column.repository",
    "overview.column.prs",
    "overview.column.ci",
  ],
  vercel: [
    "overview.column.project",
    "overview.column.vercelProject",
    "overview.column.state",
    "overview.column.last",
  ],
};

/**
 * The mark each domain's header opens with — the same one its project-scoped
 * page and its sidebar entry use, so the all-projects lens is recognizably the
 * same section rather than a separate page that happens to list projects.
 */
export const DOMAIN_MARKS: Record<OverviewDomain, (props: { className?: string }) => ReactNode> = {
  git: GitBranch,
  github: GitHubLogo,
  vercel: VercelLogo,
};

/**
 * Whether the trailing column is right-aligned.
 *
 * Only the numeric ones are — ahead/behind counts and timestamps read better
 * flush right, but GitHub's trailing column is CI wording, which would leave
 * its header hanging off the end of left-aligned values.
 */
export const DOMAIN_TRAILING_ALIGNED: Record<OverviewDomain, boolean> = {
  git: true,
  github: false,
  vercel: true,
};

/** Heading for the demoted group, which means something different per domain. */
export const DOMAIN_EMPTY_GROUP: Record<OverviewDomain, TranslationKey> = {
  git: "overview.group.git",
  github: "overview.group.github",
  vercel: "overview.group.vercel",
};

/**
 * Whether this project earns a row in the table proper.
 *
 * A project that could not be summarized is still a project the user can open,
 * so it is demoted rather than dropped — but it holds no column values, and
 * giving it a full row would let empties outnumber the live rows they are
 * supposed to sit beside.
 */
export function hasSummary(project: ProjectOverviewEntry, domain: OverviewDomain): boolean {
  if (project.error) return false;
  if (domain === "git") return Boolean(project.git);
  if (domain === "github") return Boolean(project.github);
  return Boolean(project.vercel);
}

/** The three cells after the project name, for whichever domain is in view. */
export function DomainCells({
  domain,
  project,
}: {
  domain: OverviewDomain;
  project: ProjectOverviewEntry;
}) {
  if (domain === "git") return project.git ? <GitCells overview={project.git} /> : null;
  if (domain === "github") return project.github ? <GitHubCells overview={project.github} /> : null;
  return project.vercel ? <VercelCells overview={project.vercel} /> : null;
}

function GitCells({ overview }: { overview: ProjectGitSummary }) {
  const t = useT();

  return (
    <>
      <Cell className="font-mono">
        <GitBranch className="size-3 shrink-0 text-muted-foreground" />
        <span className="truncate">{overview.branch || t("overview.detached")}</span>
      </Cell>
      <Cell className={overview.dirty > 0 ? "text-amber-500" : "text-emerald-500"}>
        {overview.dirty > 0 ? t("overview.dirty", { count: overview.dirty }) : t("overview.clean")}
      </Cell>
      <Cell className="justify-end gap-1 tabular-nums">
        {overview.ahead > 0 ? <span>↑{overview.ahead}</span> : null}
        {overview.behind > 0 ? <span>↓{overview.behind}</span> : null}
        {overview.ahead === 0 && overview.behind === 0 ? <Dash /> : null}
      </Cell>
    </>
  );
}

function GitHubCells({ overview }: { overview: ProjectGitHubSummary }) {
  const t = useT();

  return (
    <>
      <Cell className="font-mono">
        <span className="truncate">
          {overview.owner}/{overview.repo}
        </span>
      </Cell>
      <Cell>
        <GitPullRequest className="size-3 shrink-0 text-muted-foreground" />
        <span className="truncate">{t("overview.openPrs", { count: overview.openPullRequests })}</span>
      </Cell>
      <Cell
        className={cn(
          overview.checks === "success" && "text-emerald-500",
          overview.checks === "failure" && "text-red-500",
          overview.checks === "pending" && "text-amber-500",
        )}
      >
        {overview.checks ? t(`overview.checks.${overview.checks}`) : <Dash />}
      </Cell>
    </>
  );
}

function VercelCells({ overview }: { overview: ProjectVercelSummary }) {
  const t = useT();

  return (
    <>
      <Cell className="font-mono">
        <span className="truncate">{overview.projectName}</span>
      </Cell>
      <Cell>
        {overview.state ? (
          <DeploymentStateBadge state={overview.state} />
        ) : (
          <span className="truncate text-muted-foreground">{t("overview.neverDeployed")}</span>
        )}
      </Cell>
      <Cell className="justify-end tabular-nums">
        {overview.createdAt ? (
          formatRelativeTime(new Date(overview.createdAt).toISOString())
        ) : (
          <Dash />
        )}
      </Cell>
    </>
  );
}

function Cell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5 truncate", className)}>{children}</span>
  );
}

/** Holds a column's width when it has no value, so rows never collapse. */
function Dash() {
  return <span className="text-muted-foreground/40">—</span>;
}
