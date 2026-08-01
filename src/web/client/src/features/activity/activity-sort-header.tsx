import { ArrowDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type SortDirection = "asc" | "desc";

export function ActivitySortHeader({
  active,
  align = "left",
  ariaLabel,
  children,
  direction,
  onClick,
}: {
  active: boolean;
  align?: "left" | "right";
  ariaLabel: string;
  children: ReactNode;
  direction: SortDirection;
  onClick: () => void;
}) {
  return (
    <th
      aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}
      className={cn("px-2 py-1 font-semibold", align === "right" && "text-right")}
    >
      <button
        aria-label={ariaLabel}
        className={cn(
          "group inline-flex items-center gap-1 rounded-sm py-1 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          align === "right" && "ml-auto",
          active ? "text-foreground" : "text-muted-foreground",
        )}
        onClick={onClick}
        type="button"
      >
        {children}
        <ArrowDown
          aria-hidden="true"
          className={cn(
            "size-3 transition-[opacity,transform]",
            active ? "opacity-100" : "opacity-0 group-hover:opacity-50",
            active && direction === "asc" && "rotate-180",
          )}
        />
      </button>
    </th>
  );
}
