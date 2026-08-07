import { useCallback, useEffect, useState } from "react";
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
import { GitCard, GitHubCard, VercelCard } from "./project-overview-cards";

/**
 * What the Git, GitHub, and Vercel pages show when the project scope is "all".
 *
 * Those pages are single-repo by construction — they read the daemon's selected
 * repository — so an all-projects scope used to be refused on them. This is the
 * answer: an index that says what every project is doing, where clicking one
 * selects it and drops the scope, landing the user on the page they were
 * already looking at, now pointed at that project.
 */
export function ProjectOverviewGrid({
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

  if (loading && projects.length === 0) return <Loading fill label={t("common.loading")} />;
  if (error) {
    return (
      <p className="break-words p-4 font-mono text-[11px] leading-relaxed text-muted-foreground">
        {error}
      </p>
    );
  }
  if (projects.length === 0) {
    return <p className="p-4 text-[12px] text-muted-foreground">{t("overview.empty")}</p>;
  }

  return (
    <div className="grid gap-2 p-3 sm:grid-cols-2 xl:grid-cols-3">
      {projects.map((project) => (
        <ProjectCard
          domain={domain}
          entering={entering === project.name}
          key={project.name}
          onEnter={() => void enter(project.name)}
          project={project}
        />
      ))}
    </div>
  );
}

function ProjectCard({
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
      className="flex flex-col gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-left transition-colors hover:border-foreground/25 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
      disabled={entering}
      onClick={onEnter}
      title={project.path}
      type="button"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{project.name}</span>
        {entering ? (
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {t("overview.opening")}
          </span>
        ) : null}
      </span>

      {/* A project that could not be summarized still gets a card — it is
          still a project the user can open, and the reason belongs next to it
          rather than replacing the whole grid with one failure. */}
      {project.error ? (
        <span className="truncate text-[11px] text-muted-foreground">{project.error}</span>
      ) : domain === "git" ? (
        <GitCard overview={project.git} />
      ) : domain === "github" ? (
        <GitHubCard overview={project.github} />
      ) : (
        <VercelCard overview={project.vercel} />
      )}
    </button>
  );
}
