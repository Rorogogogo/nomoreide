import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { WidgetSpan } from "./widget-types";

/**
 * Literal classes, not `xl:col-span-${span}`.
 *
 * Tailwind scans source text, so an interpolated class name is never generated
 * and the widget renders full-width. Keeping the map beside the closed
 * `WidgetSpan` union makes a new span a type error here rather than a layout
 * bug at runtime.
 *
 * Two breakpoints: one column on a narrow window, two on `md`, and only at
 * `xl` does the 12-column grid mean anything — below that there isn't enough
 * width for a 4-span card to hold a number and a sentence.
 */
const SPAN_CLASS: Record<WidgetSpan, string> = {
  4: "md:col-span-1 xl:col-span-4",
  6: "md:col-span-1 xl:col-span-6",
  12: "md:col-span-2 xl:col-span-12",
};

export function WidgetGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-12">{children}</div>;
}

/**
 * A widget's frame: title, corner affordance, and the summary itself.
 *
 * The whole card is one `<button>`, which is why a widget may not contain a
 * control of its own — nested interactive elements inside a button are invalid
 * and unreachable by keyboard. That constraint is deliberate rather than
 * unfortunate: a widget with its own buttons has become a second, drifting
 * implementation of the page it summarises.
 */
export function WidgetCard({
  children,
  icon,
  onOpen,
  openLabel,
  span,
  title,
}: {
  children: ReactNode;
  icon: ReactNode;
  onOpen: () => void;
  openLabel: string;
  span: WidgetSpan;
  title: string;
}) {
  return (
    <button
      aria-label={openLabel}
      className={cn(
        "group/widget flex min-h-28 cursor-pointer flex-col gap-2 rounded-lg border border-border/60 bg-card/40 p-3 text-left transition-colors hover:border-border hover:bg-card/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        SPAN_CLASS[span],
      )}
      onClick={onOpen}
      title={openLabel}
      type="button"
    >
      <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
        <span aria-hidden className="[&_svg]:size-3.5">
          {icon}
        </span>
        {title}
        <ArrowUpRight
          aria-hidden
          className="ml-auto size-3.5 text-muted-foreground/50 transition-colors group-hover/widget:text-foreground"
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col justify-center gap-1">{children}</span>
    </button>
  );
}

/** The one number a widget leads with. */
export function WidgetFigure({ children }: { children: ReactNode }) {
  return <span className="text-2xl font-semibold leading-none tabular-nums">{children}</span>;
}

/** The line under it. Muted, because the figure is the answer. */
export function WidgetNote({ children }: { children: ReactNode }) {
  return <span className="text-[11px] leading-relaxed text-muted-foreground">{children}</span>;
}
