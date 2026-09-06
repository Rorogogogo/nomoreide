import type { ReactNode } from "react";
import { ChevronRight, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The sidebar rail: its shell, its rows, and the class names both share.
 *
 * Split out of `app.tsx` because none of it knows what a page *is* — the rail
 * collapses, a row highlights, a badge counts. `app.tsx` owns which rows exist
 * and what clicking one does.
 *
 * The collapsed rail expands on hover via `group/sidebar`, which is why the
 * class names are functions of `docked` rather than static strings.
 */

export function sidebarShellClassName(docked = false) {
  return cn(
    "group/sidebar hidden h-full shrink-0 overflow-x-hidden overflow-y-auto border-r border-border bg-card/85 py-2 backdrop-blur transition-[width,padding] duration-200 md:flex md:flex-col",
    docked ? "w-64 px-4" : "w-16 px-2 hover:w-64 hover:px-4",
  );
}

export function navButtonClassName(active: boolean, docked = false) {
  return cn(
    // h-9 rather than h-10: thirteen destinations plus their group labels have
    // to clear a laptop viewport without the rail turning into a scroller.
    "relative grid h-9 grid-cols-[48px_minmax(0,1fr)] items-center justify-start gap-0 overflow-hidden rounded-md px-0 text-sm font-medium transition-[background-color,color,width] duration-150",
    docked ? "w-full" : "w-12 group-hover/sidebar:w-full",
    active
      ? "bg-primary text-primary-foreground hover:bg-primary/90"
      : "hover:bg-muted",
  );
}

export function navButtonLabelClassName(docked = false, hasBadge = false) {
  return cn(
    "min-w-0 overflow-hidden text-left text-current transition duration-150 whitespace-pre",
    docked
      ? "translate-x-1 opacity-100"
      : "opacity-0 group-hover/sidebar:translate-x-1 group-hover/sidebar:opacity-100",
    hasBadge ? "pr-10" : "pr-3",
  );
}

export function navButtonIconClassName(docked = false) {
  return cn(
    "flex h-9 w-12 items-center justify-center text-current transition-transform duration-150 [&_svg]:size-[18px]",
    docked ? "translate-x-0" : "-translate-x-px group-hover/sidebar:translate-x-0",
  );
}

/**
 * Dock toggle. It rides in the sidebar's identity row instead of a footer of
 * its own — the rail only expands on hover anyway, which is exactly when the
 * toggle is reachable, and the reclaimed row goes to navigation.
 */
export function SidebarDockToggle({
  docked,
  onToggleDock,
}: {
  docked: boolean;
  onToggleDock?: () => void;
}) {
  return (
    <button
      aria-label={docked ? "Undock sidebar" : "Dock sidebar"}
      aria-pressed={docked}
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-[background-color,color,opacity] duration-150 hover:bg-muted hover:text-foreground [&_svg]:size-4",
        docked
          ? "bg-muted text-foreground opacity-100"
          : "opacity-0 group-hover/sidebar:opacity-100",
      )}
      onClick={onToggleDock}
      title={docked ? "Undock sidebar" : "Dock sidebar"}
      type="button"
    >
      {docked ? <PanelLeftClose /> : <PanelLeftOpen />}
    </button>
  );
}

export function AppIdentity({ className }: { className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex items-baseline gap-1.5">
        <div className="text-sm font-semibold">NoMoreIDE</div>
        <div className="font-mono text-[10px] text-muted-foreground">v{__APP_VERSION__}</div>
      </div>
      <div className="font-mono text-[11px] text-muted-foreground">
        127.0.0.1 console
      </div>
    </div>
  );
}


export function NavSectionLabel({ docked, label }: { docked: boolean; label: string }) {
  // Fixed height so the collapsed rail doesn't shift when labels fade in.
  //
  // The separating rule shares this row instead of sitting on the section
  // above it — one row per heading rather than two, which is the whole point
  // of the change. The label collapses to zero width on the rail, so the rule
  // spans the full width there and still reads as the group separator it was.
  return (
    <div className="flex h-4 items-center overflow-hidden px-3">
      <span
        className={cn(
          "overflow-hidden whitespace-pre text-[10px] font-semibold uppercase tracking-widest text-muted-foreground transition-all duration-150",
          docked
            ? "max-w-40 pr-2 opacity-100"
            : "max-w-0 pr-0 opacity-0 group-hover/sidebar:max-w-40 group-hover/sidebar:pr-2 group-hover/sidebar:opacity-100",
        )}
      >
        {label}
      </span>
      <span aria-hidden className="h-px flex-1 bg-border/60" />
    </div>
  );
}

export function NavButton({
  active,
  badge,
  child,
  docked,
  expanded,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  badge?: number;
  /** A second-layer row: indented, so the hierarchy is visible at a glance. */
  child?: boolean;
  docked: boolean;
  /**
   * Set only on a row that discloses children instead of navigating. The row
   * itself is the control, so the chevron is an indicator rather than a second
   * focusable button sitting on top of the first.
   */
  expanded?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  // Only render the count badge when there's something to count — a "0" is noise.
  const showBadge = badge !== undefined && badge > 0;
  return (
    <Button
      aria-expanded={expanded}
      aria-label={label}
      title={label}
      className={cn(
        navButtonClassName(active, docked),
        // Indent only when the labels are visible. On the collapsed rail there
        // is nothing but icons, and shifting them would break the icon column.
        child && (docked ? "pl-7" : "group-hover/sidebar:pl-7"),
      )}
      variant="ghost"
      onClick={onClick}
      type="button"
    >
      <span className={navButtonIconClassName(docked)}>
        {icon}
      </span>
      <span className={navButtonLabelClassName(docked, showBadge)}>{label}</span>
      {badge !== undefined && badge > 0 ? (
        <Badge
          appearance="solid"
          className={cn(
            "min-w-4 justify-center rounded-full border-transparent px-1 font-mono text-[10px] leading-none shadow-none",
            active
              ? "bg-primary-foreground text-primary"
              : "bg-foreground text-background",
            "absolute right-1.5 top-1.5 h-4 group-hover/sidebar:right-2 group-hover/sidebar:top-1/2 group-hover/sidebar:-translate-y-1/2 group-hover/sidebar:text-xs",
            docked && "right-2 top-1/2 -translate-y-1/2 text-xs",
          )}
          size="small"
          variant="secondary"
        >
          {badge}
        </Badge>
      ) : null}
      {expanded === undefined ? null : (
        <ChevronRight
          aria-hidden
          className={cn(
            // The trailing edge, centred on the row — this is inside the row,
            // so it centres on the row and not on the expanded group below it.
            "absolute right-2 top-1/2 size-3 -translate-y-1/2 transition-transform",
            expanded && "rotate-90",
            // Nothing but icons fits on the collapsed rail.
            docked ? "opacity-100" : "opacity-0 group-hover/sidebar:opacity-100",
          )}
        />
      )}
    </Button>
  );
}
