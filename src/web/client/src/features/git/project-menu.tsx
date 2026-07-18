import { type RefObject, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Check, FolderPlus, Globe2 } from "lucide-react";
import { useToasts } from "@/components/ui/toast";
import { selectGitRepository, type DashboardData } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Quick project-switch popover anchored under the sidebar trigger. Switching
 * is the frequent, low-stakes action so it happens in place; registering,
 * cloning, and deleting stay behind "Add or manage projects…" (the dialog).
 * Portalled + fixed like OverflowMenu so the rail's overflow-hidden can't
 * clip it; closes on outside-click, Escape, or scroll.
 */
export function ProjectMenu({
  anchor,
  data,
  scopeAll,
  onScopeChange,
  onRefresh,
  onClose,
  onManage,
  triggerRef,
}: {
  anchor: { top: number; left: number };
  data: DashboardData;
  scopeAll: boolean;
  onScopeChange: (scopeAll: boolean) => void;
  onRefresh: () => Promise<void>;
  onClose: () => void;
  onManage: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const { error: showErrorToast, success: showSuccessToast } = useToasts();
  const selectedRepository = data.git.selectedRepository;

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) {
        return;
      }
      onClose();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose, triggerRef]);

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

  return createPortal(
    <div
      className="fixed z-[1000] w-64 overflow-hidden rounded-lg border border-border bg-card shadow-lg"
      ref={menuRef}
      role="menu"
      style={{ top: anchor.top, left: anchor.left }}
    >
      <div className="max-h-72 overflow-y-auto p-1">
        <button
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted",
            scopeAll && "bg-muted/60",
          )}
          onClick={selectAllProjects}
          role="menuitem"
          type="button"
        >
          <Globe2 className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">All projects</span>
          {scopeAll ? <Check className="size-3.5 shrink-0" /> : null}
        </button>

        {data.config.gitRepositories.map((repository) => {
          const selected = !scopeAll && repository.name === selectedRepository?.name;
          return (
            <button
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted",
                selected && "bg-muted/60",
              )}
              key={repository.name}
              onClick={() => void selectProject(repository.name)}
              role="menuitem"
              type="button"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium leading-tight">
                  {repository.name}
                </span>
                <span className="block truncate font-mono text-[10px] leading-tight text-muted-foreground">
                  {repository.path}
                </span>
              </span>
              {selected ? <Check className="size-3.5 shrink-0" /> : null}
            </button>
          );
        })}
      </div>

      <div className="border-t border-border p-1">
        <button
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={() => {
            onClose();
            onManage();
          }}
          role="menuitem"
          type="button"
        >
          <FolderPlus className="size-3.5 shrink-0" />
          Add or manage projects…
        </button>
      </div>
    </div>,
    document.body,
  );
}
