import { Check, Globe2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DashboardData } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { pathInScope } from "../services/project-scope";

/**
 * The projects lane of the manage-projects dialog: every registered project,
 * how many services live inside it, and the scope-wide "all projects" lens.
 *
 * The per-project service count is what makes the hierarchy legible — a project
 * is the folder, services are what runs inside it — so it stays next to the
 * name rather than being folded into the services lane.
 */
export function ProjectList({
  data,
  onRemove,
  onSelect,
  onSelectAll,
  scopeAll,
}: {
  data: DashboardData;
  onRemove: (name: string) => void;
  onSelect: (name: string) => void;
  onSelectAll: () => void;
  scopeAll: boolean;
}) {
  const t = useT();
  const selectedRepository = data.git.selectedRepository;

  return (
    <div className="min-h-0 overflow-y-auto border-border sm:border-r">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-card px-4 py-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {t("git.repo.projectsShort")}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {t("git.repo.projectsColumnHint")}
        </span>
      </div>

      <button
        className={cn(
          "grid w-full grid-cols-[1fr_auto] items-center gap-2 border-b border-border px-4 py-2.5 text-left transition-colors hover:bg-muted",
          scopeAll && "bg-muted/70",
        )}
        onClick={onSelectAll}
        type="button"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Globe2 className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium leading-tight">
              {t("app.allProjects")}
            </span>
            <span className="block truncate text-[10px] leading-tight text-muted-foreground">
              {t("app.allProjectsHint")}
            </span>
          </span>
        </span>
        {scopeAll ? <Check className="size-3.5" /> : <span className="size-3.5" />}
      </button>

      {data.config.gitRepositories.length ? (
        <div className="divide-y divide-border">
          {data.config.gitRepositories.map((repository) => {
            const selected = !scopeAll && repository.name === selectedRepository?.name;
            const owned = data.config.services.filter((service) =>
              pathInScope(service.projectPath ?? service.cwd, repository.path),
            ).length;
            return (
              <div
                className={cn(
                  "group grid w-full grid-cols-[1fr_auto_auto_auto] items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-muted",
                  selected && "bg-muted/70",
                )}
                key={repository.name}
              >
                <button
                  className="min-w-0 text-left"
                  onClick={() => onSelect(repository.name)}
                  type="button"
                >
                  <span className="block truncate text-sm font-medium leading-tight">
                    {repository.name}
                  </span>
                  <span
                    className="block truncate font-mono text-[10px] leading-tight text-muted-foreground"
                    title={repository.path}
                  >
                    {repository.path}
                  </span>
                </button>
                <span className="whitespace-nowrap text-[10px] text-muted-foreground">
                  {owned === 1
                    ? t("git.repo.serviceCountOne", { count: owned })
                    : t("git.repo.serviceCount", { count: owned })}
                </span>
                {selected ? <Check className="size-3.5" /> : <span className="size-3.5" />}
                <Button
                  aria-label={t("git.repo.removeName", { name: repository.name })}
                  className="size-6 opacity-0 transition-opacity group-hover:opacity-100"
                  onClick={() => onRemove(repository.name)}
                  size="icon"
                  title={t("git.repo.removeName", { name: repository.name })}
                  type="button"
                  variant="ghost"
                >
                  <Trash2 className="size-3.5 text-destructive" />
                </Button>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">
          {t("git.repo.noProjects")}
        </div>
      )}
    </div>
  );
}
