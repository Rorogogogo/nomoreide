import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Box, Check, ChevronDown, FolderPlus, Globe2 } from "lucide-react";
import { useToasts } from "@/components/ui/toast";
import { selectGitRepository, type DashboardData } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { ProjectSwitcherDialog } from "./project-switcher";

/**
 * Project scope as the first crumb of the header breadcrumb — the single
 * control for "which project am I looking at". Replaces the old sidebar block:
 * scope is a lens over the whole dashboard, so it belongs on the same line as
 * the page it is scoping, not stacked in the rail.
 *
 * The rail version disclosed its list inline (it could push the nav down). Here
 * there is nothing to push, so the list is a portalled popover — same dismiss
 * behaviour as `OverflowMenu`, so it can't be clipped by the header.
 */
export function ProjectBreadcrumb({
  data,
  scopeAll,
  onScopeChange,
  onRefresh,
}: {
  data: DashboardData;
  scopeAll: boolean;
  onScopeChange: (scopeAll: boolean) => void;
  onRefresh: () => Promise<void>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { error: showErrorToast, success: showSuccessToast } = useToasts();

  const selectedRepository = data.git.selectedRepository;
  const label = scopeAll
    ? t("app.allProjects")
    : selectedRepository?.name ?? t("app.pickProject");
  // The branch is the useful second fact once a single project is in scope;
  // with everything in scope it's the project count instead.
  const hint = scopeAll
    ? null
    : (data.git.status?.branch ?? null);

  function toggle() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setCoords({ top: rect.bottom + 4, left: rect.left });
    setOpen((value) => !value);
  }

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    /**
     * The menu is positioned once, at fixed coordinates taken from the trigger,
     * so a scroll anywhere behind it would leave it stranded — hence closing on
     * a capture-phase scroll from any ancestor. Its own project list scrolls
     * too, though, and that scroll reaches the same capture listener, so
     * dismissing unconditionally made the list impossible to scroll. Scrolls
     * originating inside the menu move nothing it is anchored to.
     */
    function onScroll(event: Event) {
      if (menuRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  async function selectProject(name: string) {
    setOpen(false);
    try {
      await selectGitRepository(name);
      onScopeChange(false);
      await onRefresh();
      showSuccessToast(t("git.repo.switchedToast", { name }));
    } catch (caught) {
      showErrorToast(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t("app.projectScope", { label })}
        className={cn(
          "flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-transparent px-1.5 text-left transition-colors hover:border-border hover:bg-muted",
          open && "border-border bg-muted",
        )}
        onClick={toggle}
        ref={triggerRef}
        title={t("app.projectScope", { label })}
        type="button"
      >
        <span className="flex size-5 shrink-0 items-center justify-center rounded border border-border bg-background text-[10px] font-semibold">
          {scopeAll ? (
            <Globe2 className="size-3 text-muted-foreground" />
          ) : selectedRepository ? (
            label.charAt(0).toUpperCase()
          ) : (
            <Box className="size-3 text-muted-foreground" />
          )}
        </span>
        <span className="truncate text-sm font-medium">{label}</span>
        {hint ? (
          <span className="hidden truncate font-mono text-[11px] text-muted-foreground sm:inline">
            {hint}
          </span>
        ) : null}
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {/* Only the project list scrolls. "Add or manage" is pinned as a footer
          because it is the one row that must stay reachable no matter how many
          projects are registered — inside the scroll area it falls below the
          fold at ~10 projects and the menu looks like it offers no way to add
          a project at all. */}
      {open
        ? createPortal(
            <div
              className="fixed z-50 flex max-h-80 min-w-56 flex-col rounded-md border border-border bg-card p-1 shadow-md"
              ref={menuRef}
              role="menu"
              style={{ top: coords.top, left: coords.left }}
            >
              <div className="min-h-0 flex-1 overflow-y-auto">
                <MenuRow
                  active={scopeAll}
                  icon={<Globe2 className="size-3.5 text-muted-foreground" />}
                  label={t("app.allProjects")}
                  onSelect={() => {
                    setOpen(false);
                    onScopeChange(true);
                    showSuccessToast(t("app.showingAllProjects"));
                  }}
                />
                {data.config.gitRepositories.map((repository) => (
                  <MenuRow
                    active={!scopeAll && selectedRepository?.name === repository.name}
                    icon={
                      <span className="flex size-3.5 items-center justify-center text-[9px] font-semibold text-muted-foreground">
                        {repository.name.charAt(0).toUpperCase()}
                      </span>
                    }
                    key={repository.name}
                    label={repository.name}
                    onSelect={() => void selectProject(repository.name)}
                  />
                ))}
              </div>
              <div className="my-1 h-px shrink-0 bg-border" />
              <MenuRow
                active={false}
                icon={<FolderPlus className="size-3.5 text-muted-foreground" />}
                label={`${t("app.addManageProjects")}…`}
                onSelect={() => {
                  setOpen(false);
                  setManageOpen(true);
                }}
              />
            </div>,
            document.body,
          )
        : null}

      {manageOpen ? (
        <ProjectSwitcherDialog
          data={data}
          onClose={() => setManageOpen(false)}
          onRefresh={onRefresh}
          onScopeChange={onScopeChange}
          scopeAll={scopeAll}
        />
      ) : null}
    </>
  );
}

function MenuRow({
  active,
  icon,
  label,
  onSelect,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onSelect: () => void;
}) {
  return (
    <button
      className={cn(
        "flex w-full shrink-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted",
        active && "bg-muted/60",
      )}
      onClick={onSelect}
      role="menuitem"
      type="button"
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {active ? <Check className="size-3.5 shrink-0 text-muted-foreground" /> : null}
    </button>
  );
}
