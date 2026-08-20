import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  listProjectOverview,
  selectGitRepository,
  type OverviewDomain,
  type ProjectOverviewEntry,
} from "@/lib/api";
import { Loading } from "@/components/ui/loading";
import { useRegisterRefresh } from "@/components/refresh-registry";
import { useToasts } from "@/components/ui/toast";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  DOMAIN_EMPTY_GROUP,
  DOMAIN_HEADERS,
  DOMAIN_MARKS,
  DOMAIN_TEMPLATES,
  DOMAIN_TRAILING_ALIGNED,
  DomainCells,
  hasSummary,
} from "./project-overview-columns";

/**
 * What the Git, GitHub, and Vercel pages show when the project scope is "all".
 *
 * Those pages are single-repo by construction — they read the daemon's selected
 * repository — so an all-projects scope used to be refused on them. This is the
 * answer: an index that says what every project is doing, where clicking one
 * selects it and drops the scope, landing the user on the page they were
 * already looking at, now pointed at that project.
 *
 * It is a table rather than a card grid because the projects are homogeneous:
 * every one has the same three attributes, and the useful question is almost
 * always a comparison ("which of these is dirty", "which failed"). Columns let
 * that question be answered by running down one line; boxes do not.
 */
export function ProjectOverviewTable({
  domain,
  onEnterProject,
}: {
  domain: OverviewDomain;
  /** Called after the daemon's selection has moved, so the page can re-read. */
  onEnterProject: () => void;
}) {
  const t = useT();
  const toasts = useToasts();
  const [projects, setProjects] = useState<ProjectOverviewEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [entering, setEntering] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setProjects(await listProjectOverview(domain));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [domain]);

  useEffect(() => {
    void load();
  }, [load]);
  useRegisterRefresh(useCallback(() => void load(), [load]));

  // Registration order is preserved inside each group: the split is what pushes
  // the empties out of the way, and re-sorting on top of it would move rows
  // around between refreshes for no gain.
  const [summarized, unsummarized] = useMemo(() => {
    const withData: ProjectOverviewEntry[] = [];
    const without: ProjectOverviewEntry[] = [];
    for (const project of projects) {
      (hasSummary(project, domain) ? withData : without).push(project);
    }
    return [withData, without];
  }, [projects, domain]);

  async function enter(name: string) {
    setEntering(name);
    try {
      await selectGitRepository(name);
      onEnterProject();
    } catch (caught) {
      toasts.error(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setEntering(null);
    }
  }

  // Every branch renders inside `Surface`, including these — a bare early
  // return would let the body grid show through on exactly the screens with
  // the least on them.
  if (loading && projects.length === 0) {
    return (
      <Surface>
        <Loading fill label={t("common.loading")} />
      </Surface>
    );
  }
  if (error) {
    return (
      <Surface>
        <p className="break-words p-4 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {error}
        </p>
      </Surface>
    );
  }
  if (projects.length === 0) {
    return (
      <Surface>
        <p className="p-4 text-[12px] text-muted-foreground">{t("overview.empty")}</p>
      </Surface>
    );
  }

  const template = DOMAIN_TEMPLATES[domain];

  return (
    <Surface>
      <OverviewHeader domain={domain} linked={summarized.length} total={projects.length} />
      <div className="w-full px-4 py-4">
      {summarized.length > 0 ? (
        <div>
          <div
            className={cn(
              "grid items-center gap-x-4 border-b border-border px-2 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70",
              template,
            )}
          >
            {DOMAIN_HEADERS[domain].map((key, index) => (
              <span
                className={cn(
                  "truncate",
                  index === DOMAIN_HEADERS[domain].length - 1 &&
                    DOMAIN_TRAILING_ALIGNED[domain] &&
                    "text-right",
                )}
                key={key}
              >
                {t(key)}
              </span>
            ))}
          </div>
          {summarized.map((project) => (
            <ProjectRow
              domain={domain}
              entering={entering === project.name}
              key={project.name}
              onEnter={() => void enter(project.name)}
              project={project}
            />
          ))}
        </div>
      ) : null}

        {unsummarized.length > 0 ? (
          <EmptyGroup
            domain={domain}
            onEnter={(name) => void enter(name)}
            projects={unsummarized}
            spaced={summarized.length > 0}
          />
        ) : null}
      </div>
    </Surface>
  );
}

/**
 * The all-projects header.
 *
 * The project-scoped pages all open with their domain's mark and the project's
 * name; the all-projects lens had no header at all, so switching scope dropped
 * you onto a bare table and the page lost the identity its sibling had. Same
 * bar, same mark, with the scope's name in place of a project's.
 */
function OverviewHeader({
  domain,
  linked,
  total,
}: {
  domain: OverviewDomain;
  /** Projects the domain could actually summarize, of `total` registered. */
  linked: number;
  total: number;
}) {
  const t = useT();
  const Mark = DOMAIN_MARKS[domain];

  return (
    <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      <Mark className="size-3.5 shrink-0" />
      <span className="truncate text-[12px] font-medium">{t("overview.allProjects")}</span>
      <span className="text-[11px] text-muted-foreground">
        {t("overview.summary", { linked, total })}
      </span>
    </header>
  );
}

/**
 * The page's own background.
 *
 * `body` paints a 40px line grid, so a transparent page lets it run straight
 * through the content. Every other view covers it with a flat `bg-background`;
 * this is that, so the overview matches the pages it sits beside.
 */
function Surface({ children }: { children: ReactNode }) {
  return <div className="h-full min-h-0 overflow-auto bg-background">{children}</div>;
}

function ProjectRow({
  domain,
  entering,
  onEnter,
  project,
}: {
  domain: OverviewDomain;
  entering: boolean;
  onEnter: () => void;
  project: ProjectOverviewEntry;
}) {
  const t = useT();

  return (
    <button
      className={cn(
        "grid w-full items-center gap-x-4 border-b border-border/40 px-2 py-2 text-left text-[11px] text-muted-foreground transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60",
        DOMAIN_TEMPLATES[domain],
      )}
      disabled={entering}
      onClick={onEnter}
      title={project.path}
      type="button"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-[12px] font-medium text-foreground">{project.name}</span>
        {entering ? (
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {t("overview.opening")}
          </span>
        ) : null}
      </span>
      <DomainCells domain={domain} project={project} />
    </button>
  );
}

/**
 * Projects with nothing to report, kept reachable but out of the way.
 *
 * They stay clickable because "not linked yet" is often exactly the project you
 * came to open — but as names on a line, not as rows of blanks.
 */
function EmptyGroup({
  domain,
  onEnter,
  projects,
  spaced,
}: {
  domain: OverviewDomain;
  onEnter: (name: string) => void;
  projects: ProjectOverviewEntry[];
  spaced: boolean;
}) {
  const t = useT();

  return (
    <div className={cn(spaced && "mt-6")}>
      <p className="px-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
        {t(DOMAIN_EMPTY_GROUP[domain])} · {projects.length}
      </p>
      <div className="flex flex-wrap gap-x-1 gap-y-1 px-1 pt-2">
        {projects.map((project) => (
          <button
            className="max-w-full truncate rounded border border-transparent px-1.5 py-0.5 text-[11px] text-muted-foreground/70 transition-colors hover:border-border hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            key={project.name}
            onClick={() => onEnter(project.name)}
            // The reason a project is here is worth having, but not worth a
            // line of its own — it rides along as the row's tooltip.
            title={project.error ?? project.path}
            type="button"
          >
            {project.name}
          </button>
        ))}
      </div>
    </div>
  );
}
