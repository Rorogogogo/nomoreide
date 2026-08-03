import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type Side = "top" | "bottom" | "left" | "right";
type Align = "center" | "end";

const sideClasses: Record<Side, string> = {
  top: "bottom-full left-1/2 mb-1.5 -translate-x-1/2",
  bottom: "top-full left-1/2 mt-1.5 -translate-x-1/2",
  left: "right-full top-1/2 mr-1.5 -translate-y-1/2",
  right: "left-full top-1/2 ml-1.5 -translate-y-1/2",
};

/**
 * `align="end"` for top/bottom tooltips on controls near the right edge: a
 * centered bubble on a header icon 20px from the window edge gets clipped.
 */
const alignEndClasses: Partial<Record<Side, string>> = {
  top: "left-auto right-0 translate-x-0",
  bottom: "left-auto right-0 translate-x-0",
};

export function Tooltip({
  label,
  children,
  side = "bottom",
  align = "center",
  className,
  disabled = false,
}: {
  label: ReactNode;
  children: ReactNode;
  side?: Side;
  align?: Align;
  className?: string;
  /** Suppresses the bubble without unwrapping the trigger — for controls that
      open a menu, where a hover tooltip would sit on top of it. */
  disabled?: boolean;
}) {
  return (
    <span className={cn("group/tt relative inline-flex", className)}>
      {children}
      {disabled ? null : (
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute z-[1100] whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background shadow-md",
          "opacity-0 transition-opacity duration-150 group-hover/tt:opacity-100",
          sideClasses[side],
          align === "end" && alignEndClasses[side],
        )}
      >
        {label}
      </span>
      )}
    </span>
  );
}
