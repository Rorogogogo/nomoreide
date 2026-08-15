import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { WidgetSpan } from "./widget-types";

/**
 * Home's presentation primitives.
 *
 * These exist so a widget author writes *what it knows*, never how it looks —
 * one widget styling its own numbers is how six widgets become six dialects.
 * The vocabulary is deliberately small: a stat strip, rows, a note. If a widget
 * needs something outside it, either the vocabulary is short a word or the
 * widget is trying to be its page (see the hard rule in `widget-types.ts`).
 *
 * The look is `DESIGN.md`: **lines, not boxes.** Nothing here draws a card.
 */

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
 * width for a 4-span panel to hold a stat strip and a row list.
 */
const SPAN_CLASS: Record<WidgetSpan, string> = {
  4: "md:col-span-1 xl:col-span-4",
  6: "md:col-span-1 xl:col-span-6",
  12: "md:col-span-2 xl:col-span-12",
};

/** What a number or a row *means*, in the fixed vocabulary of `DESIGN.md`. */
export type WidgetTone = "ok" | "warn" | "bad" | "idle";

const TEXT_TONE: Record<WidgetTone, string> = {
  ok: "text-emerald-500",
  warn: "text-amber-500",
  bad: "text-red-500",
  idle: "text-foreground",
};

const DOT_TONE: Record<WidgetTone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-red-500",
  idle: "bg-zinc-500/60",
};

/**
 * The grid itself draws no rules — each panel draws its own bottom and right
 * hairline, which is the only arrangement that survives a half-filled last row
 * (stage 2 lets a user remove widgets, so that row *will* happen).
 *
 * `-mr-px` inside `overflow-hidden` pushes the rightmost column's rule out of
 * view, so the grid ends flush with the panel edge instead of drawing a border
 * down the outside of a full-bleed page.
 */
export function WidgetGrid({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden">
      <div className="-mr-px grid grid-cols-1 md:grid-cols-2 xl:grid-cols-12">{children}</div>
    </div>
  );
}

/**
 * One widget's cell: an uppercase rule-style header, then whatever it knows.
 *
 * The whole panel is a single `<button>`, which is why a widget may not contain
 * a control of its own — nested interactive elements inside a button are
 * invalid and unreachable by keyboard. That constraint is deliberate rather
 * than unfortunate: a widget with its own buttons has become a second,
 * drifting implementation of the page it summarises.
 */
export function WidgetPanel({
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
        "group/widget flex cursor-pointer flex-col gap-2 border-b border-border px-3 py-2.5 text-left transition-colors hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:border-r",
        SPAN_CLASS[span],
      )}
      onClick={onOpen}
      title={openLabel}
      type="button"
    >
      <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        <span aria-hidden className="[&_svg]:size-3">
          {icon}
        </span>
        {title}
        <ArrowUpRight
          aria-hidden
          className="ml-auto size-3 text-muted-foreground/40 transition-colors group-hover/widget:text-foreground"
        />
      </span>
      {children}
    </button>
  );
}

/**
 * The counters a widget leads with, split by hairlines rather than tiled —
 * `DESIGN.md` again, and the reason nothing here is 24px: a dashboard number is
 * read against its neighbours, so three 13px figures beat one large one.
 */
export function WidgetStats({ children }: { children: ReactNode }) {
  return <span className="flex flex-wrap divide-x divide-border">{children}</span>;
}

export function WidgetStat({
  label,
  tone = "idle",
  value,
}: {
  label: string;
  tone?: WidgetTone;
  value: ReactNode;
}) {
  return (
    <span className="flex flex-col gap-1 px-3 first:pl-0">
      <span
        className={cn("text-[13px] font-semibold leading-none tabular-nums", TEXT_TONE[tone])}
      >
        {value}
      </span>
      <span className="text-[10px] uppercase leading-none tracking-wide text-muted-foreground">
        {label}
      </span>
    </span>
  );
}

/** The list under the stats — the part that says *which*, not *how many*. */
export function WidgetRows({ children }: { children: ReactNode }) {
  return <span className="flex min-w-0 flex-col gap-1">{children}</span>;
}

/**
 * A row: status mark, identifier, what's true about it, and when.
 *
 * `name` is monospaced because at this size it is always a machine identifier —
 * a service, a port, a path. `meta` is prose and stays sans; wrap anything
 * machine-readable inside it in `WidgetId`.
 */
export function WidgetRow({
  meta,
  name,
  tone,
  trailing,
}: {
  meta?: ReactNode;
  name: ReactNode;
  tone?: WidgetTone;
  trailing?: ReactNode;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-[11px] leading-tight">
      {tone ? <WidgetDot tone={tone} /> : null}
      <span className="max-w-[50%] shrink-0 truncate font-mono text-foreground">{name}</span>
      {meta ? <span className="min-w-0 flex-1 truncate text-muted-foreground">{meta}</span> : null}
      {trailing ? (
        <span className="ml-auto shrink-0 pl-1 text-[10px] tabular-nums text-muted-foreground/70">
          {trailing}
        </span>
      ) : null}
    </span>
  );
}

export function WidgetDot({ tone }: { tone: WidgetTone }) {
  return <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT_TONE[tone])} />;
}

/** A machine identifier appearing inside a `meta` cell. */
export function WidgetId({ children }: { children: ReactNode }) {
  return <span className="font-mono">{children}</span>;
}

/** The "and 14 others" line that keeps a row list from becoming a log. */
export function WidgetMore({ children }: { children: ReactNode }) {
  return <span className="text-[10px] text-muted-foreground/70">{children}</span>;
}

/** An empty state, or the one sentence a widget has when it has no rows. */
export function WidgetNote({ children }: { children: ReactNode }) {
  return <span className="text-[12px] text-muted-foreground">{children}</span>;
}
