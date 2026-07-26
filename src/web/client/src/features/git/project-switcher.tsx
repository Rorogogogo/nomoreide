import { createPortal } from "react-dom";
import { Globe2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToasts } from "@/components/ui/toast";
import { deleteGitRepository, selectGitRepository, type DashboardData } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { ServiceProjectTable } from "../services/service-project-table";
import { AddProjectForm } from "./add-project-form";
import { ProjectList } from "./project-list";

/** Shared with the header breadcrumb, which offers the same "manage" entry. */
export function ProjectSwitcherDialog({
  data,
  onClose,
  onRefresh,
  onScopeChange,
  scopeAll,
}: {
  data: DashboardData;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onScopeChange: (scopeAll: boolean) => void;
  scopeAll: boolean;
}) {
  const t = useT();
  const { error: showErrorToast, success: showSuccessToast } = useToasts();

  async function selectProject(name: string) {
    try {
      await selectGitRepository(name);
      onScopeChange(false);
      onClose();
      await onRefresh();
      showSuccessToast(t("git.repo.switchedToast", { name }));
    } catch (caught) {
      showErrorToast(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function selectAllProjects() {
    onScopeChange(true);
    onClose();
    showSuccessToast(t("app.showingAllProjects"));
  }

  async function removeProject(name: string) {
    try {
      await deleteGitRepository(name);
      await onRefresh();
      showSuccessToast(t("git.repo.removedToast", { name }));
    } catch (caught) {
      showErrorToast(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[1000] grid place-items-center bg-black/35 px-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {/* Height is capped and the two lanes scroll on their own, so the add
          section stays reachable no matter how long either list gets. */}
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl">
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
          <Globe2 className="size-4 text-muted-foreground" />
          <div className="min-w-0">
            <div className="text-sm font-semibold leading-tight">
              {t("git.repo.projectsShort")}
            </div>
            {/* States the containment outright: a project is the folder, services
                are what runs inside it. Without this the two lanes read as two
                unrelated lists. */}
            <div className="truncate text-[10px] leading-tight text-muted-foreground">
              {t("git.repo.projectsSubtitle")}
            </div>
          </div>
          <Badge className="h-5 px-1.5 text-[10px]" variant="outline">
            {data.config.gitRepositories.length}
          </Badge>
          <Button
            aria-label={t("git.repo.closeSwitcher")}
            className="ml-auto size-7"
            onClick={onClose}
            size="icon"
            variant="ghost"
          >
            <X className="size-4" />
          </Button>
        </div>

        {/* Two lanes: the projects on the left, what runs inside them on the
            right. Which services a project owns is edited here, next to the
            projects themselves — the service's own edit form can set this too,
            but only one service at a time and with no view of what is stranded. */}
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden sm:grid-cols-2">
          <ProjectList
            data={data}
            onRemove={(name) => void removeProject(name)}
            onSelect={(name) => void selectProject(name)}
            onSelectAll={selectAllProjects}
            scopeAll={scopeAll}
          />
          <div className="min-h-0 overflow-y-auto border-t border-border sm:border-t-0">
            <ServiceProjectTable data={data} onRefresh={onRefresh} />
          </div>
        </div>

        <AddProjectForm
          data={data}
          onAdded={onClose}
          onCreated={(name) => selectProject(name)}
          onRefresh={onRefresh}
        />
      </div>
    </div>,
    document.body,
  );
}
