import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useToasts } from "@/components/ui/toast";
import { adoptGitRepository, setServiceProject, type DashboardData } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { pathInScope, unassignedServices } from "./project-scope";

/**
 * Every registered service against the project it belongs to, with the
 * assignment editable in place. Lives in the manage-projects dialog because
 * that is where the projects themselves are edited — assigning one service at
 * a time through its own edit form gives no overview of what is unassigned.
 *
 * Rows are labelled `inferred` or `pinned` so the difference stays visible:
 * an inferred row follows `cwd` and re-resolves if the path moves, a pinned one
 * never changes until it is cleared.
 */
export function ServiceProjectTable({
  data,
  onRefresh,
}: {
  data: DashboardData;
  onRefresh: () => Promise<void>;
}) {
  const t = useT();
  const { error: showErrorToast, success: showSuccessToast } = useToasts();
  const [saving, setSaving] = useState<string | null>(null);
  const services = data.config.services;
  const repositories = data.config.gitRepositories;
  const unassignedCount = unassignedServices(services, repositories).length;

  /**
   * The only way out of "no project matches" used to be retyping the path into
   * the add form. The service already knows where it runs, so offer that folder
   * directly — the endpoint resolves it to the enclosing worktree root.
   */
  async function adopt(serviceName: string, cwd: string) {
    setSaving(serviceName);
    try {
      const { name } = await adoptGitRepository(cwd);
      await onRefresh();
      showSuccessToast(t("git.repo.addedToast", { name }));
    } catch (caught) {
      showErrorToast(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(null);
    }
  }

  async function assign(name: string, projectPath: string) {
    setSaving(name);
    try {
      await setServiceProject(name, projectPath || undefined);
      await onRefresh();
      showSuccessToast(t("services.project.savedToast", { name }));
    } catch (caught) {
      showErrorToast(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(null);
    }
  }

  if (services.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">
        {t("services.project.noServices")}
      </div>
    );
  }

  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-card px-3 py-1">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {t("services.project.tableTitle")}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {unassignedCount > 0
            ? t("services.project.countWithUnassigned", {
                total: services.length,
                unassigned: unassignedCount,
              })
            : t("services.project.count", { total: services.length })}
        </span>
      </div>
      <div className="divide-y divide-border">
        {services.map((service) => {
          const pinned = Boolean(service.projectPath);
          // What the row resolves to today, however it got there.
          const owner = repositories.find((repository) =>
            pathInScope(service.projectPath ?? service.cwd, repository.path),
          );
          // What clearing the pin would fall back to — named on the default
          // option so the consequence is visible before choosing it.
          const inferredOwner = repositories.find((repository) =>
            pathInScope(service.cwd, repository.path),
          );
          return (
            <div
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto] items-center gap-2 px-3 py-1.5 transition-colors hover:bg-muted/20"
              key={service.name}
            >
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium leading-tight">
                  {service.name}
                </span>
                <span
                  className="block truncate font-mono text-[10px] leading-tight text-muted-foreground"
                  title={service.cwd}
                >
                  {service.cwd}
                </span>
              </span>
              <select
                aria-label={t("services.project.selectAria", { name: service.name })}
                className={cn(
                  // pr-6 keeps the longest option clear of the native chevron —
                  // without it the label renders straight under the arrow.
                  "h-7 w-full truncate rounded-md border border-border bg-background py-0 pl-1.5 pr-6 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  !owner && "border-amber-500/70",
                )}
                disabled={saving === service.name}
                onChange={(event) => void assign(service.name, event.target.value)}
                title={t("services.project.selectTitle")}
                value={service.projectPath ?? ""}
              >
                <option value="">
                  {inferredOwner
                    ? t("services.project.inferredAs", { name: inferredOwner.name })
                    : t("services.project.inferredNone")}
                </option>
                {repositories.map((repository) => (
                  <option key={repository.path} value={repository.path}>
                    {repository.name}
                  </option>
                ))}
                {/* A pin can outlive the project it points at (the project was
                    removed). Without an option carrying that path the select
                    would silently display the wrong row as selected. */}
                {pinned && !owner ? (
                  <option value={service.projectPath}>
                    {t("services.project.missingProject", { path: service.projectPath ?? "" })}
                  </option>
                ) : null}
              </select>
              {!owner ? (
                // Without a cwd there is no folder to adopt — the row can only
                // flag itself and wait for a manual pin.
                service.cwd ? (
                  <button
                    aria-label={t("services.project.adoptAria", { name: service.name })}
                    className="flex items-center gap-1 whitespace-nowrap rounded px-1 py-0.5 text-[10px] text-amber-600 transition-colors hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 dark:text-amber-500"
                    disabled={saving === service.name}
                    onClick={() => void adopt(service.name, service.cwd ?? "")}
                    title={t("services.project.adoptTitle")}
                    type="button"
                  >
                    <AlertTriangle aria-hidden="true" className="size-3.5" />
                    {t("services.project.adopt")}
                  </button>
                ) : (
                  <AlertTriangle
                    aria-label={t("services.project.unassignedAria")}
                    className="size-3.5 text-amber-500"
                  />
                )
              ) : (
                <span className="text-[10px] text-muted-foreground">
                  {pinned ? t("services.project.pinned") : t("services.project.inferred")}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
