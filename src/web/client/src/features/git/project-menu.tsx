import { Check, FolderPlus, Globe2 } from "lucide-react";
import { useToasts } from "@/components/ui/toast";
import { selectGitRepository, type DashboardData } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Inline project list, disclosed under the sidebar trigger (no popover — it
 * expands in place and pushes the nav down). Switching is the frequent,
 * low-stakes action so it happens here; adding, cloning, and deleting live in
 * the dialog behind "Add or manage projects…" — the rail is too narrow for
 * path inputs. Rows follow the nav buttons' collapsed-rail pattern: 48px
 * icon column, labels fade in when the rail is docked or hovered.
 */
export function ProjectMenuList({
  data,
  docked,
  scopeAll,
  onScopeChange,
  onRefresh,
  onClose,
  onManage,
}: {
  data: DashboardData;
  docked: boolean;
  scopeAll: boolean;
  onScopeChange: (scopeAll: boolean) => void;
  onRefresh: () => Promise<void>;
  onClose: () => void;
  onManage: () => void;
}) {
  const { error: showErrorToast, success: showSuccessToast } = useToasts();
  const selectedRepository = data.git.selectedRepository;

  async function selectProject(name: string) {
    onClose();
    try {
      await selectGitRepository(name);
      onScopeChange(false);
      await onRefresh();
      showSuccessToast(`Switched to ${name}.`);
    } catch (caught) {
      showErrorToast(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function selectAllProjects() {
    onClose();
    onScopeChange(true);
    showSuccessToast("Showing all projects.");
  }

  const rowClassName = (active: boolean) =>
    cn(
      "grid h-8 grid-cols-[48px_minmax(0,1fr)] items-center overflow-hidden rounded-md text-left transition-[background-color,width] duration-150 hover:bg-muted",
      docked ? "w-full" : "w-12 group-hover/sidebar:w-full",
      active && "bg-muted/60",
    );
  const labelClassName = cn(
    "flex min-w-0 items-center gap-2 overflow-hidden whitespace-pre pr-2 text-xs transition duration-150",
    docked
      ? "translate-x-1 opacity-100"
      : "opacity-0 group-hover/sidebar:translate-x-1 group-hover/sidebar:opacity-100",
  );

  return (
    <div className="mt-1 grid gap-0.5">
      <button
        className={rowClassName(scopeAll)}
        onClick={selectAllProjects}
        title="All projects"
        type="button"
      >
        <span className="flex h-8 w-12 items-center justify-center">
          <Globe2 className="size-4 text-muted-foreground" />
        </span>
        <span className={labelClassName}>
          <span className="min-w-0 flex-1 truncate font-medium">All projects</span>
          {scopeAll ? <Check className="size-3.5 shrink-0" /> : null}
        </span>
      </button>

      {data.config.gitRepositories.map((repository) => {
        const selected = !scopeAll && repository.name === selectedRepository?.name;
        return (
          <button
            className={rowClassName(selected)}
            key={repository.name}
            onClick={() => void selectProject(repository.name)}
            title={repository.path}
            type="button"
          >
            <span aria-hidden className="h-8 w-12" />
            <span className={labelClassName}>
              <span className="min-w-0 flex-1 truncate font-medium">{repository.name}</span>
              {selected ? <Check className="size-3.5 shrink-0" /> : null}
            </span>
          </button>
        );
      })}

      <button
        className={cn(
          "grid h-8 grid-cols-[48px_minmax(0,1fr)] items-center overflow-hidden rounded-md text-left text-muted-foreground transition-[background-color,color,width] duration-150 hover:bg-muted hover:text-foreground",
          docked ? "w-full" : "w-12 group-hover/sidebar:w-full",
        )}
        onClick={() => {
          onClose();
          onManage();
        }}
        title="Add or manage projects"
        type="button"
      >
        <span className="flex h-8 w-12 items-center justify-center">
          <FolderPlus className="size-4" />
        </span>
        <span className={labelClassName}>
          <span className="min-w-0 flex-1 truncate">Add or manage projects…</span>
        </span>
      </button>
    </div>
  );
}
