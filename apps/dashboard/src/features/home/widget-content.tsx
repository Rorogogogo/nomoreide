import { useContext, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { openExternal } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { WidgetDisclosureContext } from "./widget-context";
import type { WidgetTone } from "./widget-tone";
import { DIM_TONE, DOT_TONE, TEXT_TONE } from "./widget-tone";

/**
 * What goes *inside* a widget: its counters, rows, status dots and links.
 *
 * Split from `widget-grid.tsx`, which owns the grid, the panels and the drag
 * frame — the container. Nothing here knows it is in a panel, which is why the
 * same pieces work in a docked stats header as in a widget body.
 */

/** What a counter shows before it has an answer — never a zero. */
const PENDING = "—";

/**
 * A counter. `label` is still required and still translated — it just isn't
 * *drawn*: it becomes the accessible name and the hover title.
 *
 * Six widgets with three labelled counters each put eighteen uppercase words on
 * a page whose whole job is to be glanced at, and the words were the same every
 * refresh while the numbers were the part that changed. Dropping them costs a
 * first-run guess and buys a page you can read without reading.
 *
 * `pending` exists because a widget that fetches its own data has a state the
 * dashboard-backed ones don't: not asked yet. Rendering `0` there is not a
 * placeholder, it is a wrong answer stated in the same typeface as a right one —
 * "0 MCP servers connected" is alarming and, while the request is in flight,
 * untrue. A dash says nothing, which is what the widget knows.
 */
export function WidgetStat({
  label,
  pending = false,
  tone = "idle",
  value,
}: {
  label: string;
  pending?: boolean;
  tone?: WidgetTone;
  value: ReactNode;
}) {
  const dim = pending || value === 0;
  return (
    <span
      className={cn(
        "px-2.5 text-[13px] font-semibold leading-none tabular-nums first:pl-0",
        dim ? DIM_TONE[tone] : TEXT_TONE[tone],
      )}
      title={label}
    >
      {pending ? PENDING : value}
      {/*
        The label survives for anyone not reading by colour: `sr-only` keeps it
        out of the layout while a screen reader still hears "3, running".
        `aria-label` on a bare span would be dropped — a span carries no role to
        hang it on.
      */}
      <span className="sr-only"> {label}</span>
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
 *
 * Both leading cells are optional, and between them they cover the two kinds of
 * row this page has:
 *
 * - `tone` draws the status dot, and `mark` replaces it with a glyph for rows
 *   whose leading fact is *what made this* rather than *how it is doing* — a
 *   conversation is not healthy or failing, it is Claude's or Codex's. A row
 *   passing `mark` should put the same word in an `sr-only` span inside it;
 *   colour is not a label.
 * - Omitting `name` is for a row whose subject is prose. A conversation's
 *   identifier is a uuid nobody reads, so the title takes the whole width
 *   instead of being squeezed into `meta` beside seven meaningless characters.
 */
export function WidgetRow({
  mark,
  meta,
  name,
  tone,
  trailing,
}: {
  mark?: ReactNode;
  meta?: ReactNode;
  name?: ReactNode;
  tone?: WidgetTone;
  trailing?: ReactNode;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-[11px] leading-tight">
      {mark ? (
        <span className="flex shrink-0 items-center [&_svg]:size-3">{mark}</span>
      ) : tone ? (
        <WidgetDot tone={tone} />
      ) : null}
      {name ? (
        <span className="max-w-[50%] shrink-0 truncate font-mono text-foreground">{name}</span>
      ) : null}
      {/*
        Muted only when it is the *second* text cell. The row's leading text is
        its subject and reads at full strength; `meta` is normally the sentence
        about the identifier beside it, but on a `name`-less row it is the
        subject itself and a whole row of muted text would demote it.
      */}
      {meta ? (
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            name ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {meta}
        </span>
      ) : null}
      {/*
        Truncatable, not `shrink-0`. A trailing cell is usually a timestamp and
        was pinned at its natural width for that reason — until the repository
        row put a full upstream ref in it and
        `origin/xwangrobert/ror-105-rebuild-homes-widgets-…` ran straight off
        the panel and out of the viewport. This is the exact blow-out
        `docs/DESIGN.md` warns about for long branch names.
      */}
      {trailing ? (
        <span className="ml-auto min-w-0 max-w-[50%] truncate pl-1 text-[10px] tabular-nums text-muted-foreground/70">
          {trailing}
        </span>
      ) : null}
    </span>
  );
}

/**
 * How many rows a widget should print: its own cap when the panel is fitting
 * its content, everything when the user has given the panel a height.
 *
 * One function so the rule is written once. See `WidgetRenderProps.height` for
 * why the cap is conditional at all; the short version is that a cap and a
 * scrollbar contradict each other, and the height says which of the two the
 * user asked for.
 */
export function rowCap(height: number | null, cap: number): number {
  return height === null ? cap : Number.POSITIVE_INFINITY;
}

export function WidgetDot({ tone }: { tone: WidgetTone }) {
  return <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT_TONE[tone])} />;
}

/**
 * Open the thing a row *names* — the running service itself, not the page that
 * lists it.
 *
 * This is allowed in a widget for the same reason the header arrow is: it is a
 * link, and a link changes nothing. The rule a widget lives under is about what
 * a control *acts on* — start, stop and restart act on the world and stay on
 * the page the arrow opens, while going somewhere is the one thing a summary
 * has always been allowed to offer. What it saves is the whole reason the panel
 * exists: seeing that a service is up and reaching it were two different
 * places, so reading Home told you where to go and then made you go there to go
 * somewhere else.
 *
 * Styled like the arrow, and quiet for the same reason — one of these per row
 * is a lot of marks on a summary, so they come up with the panel under the
 * cursor and stay out of the way of the names, which are what is being read.
 *
 * Only offer it for something actually reachable. A link to a service that is
 * not running is a dead tab, which is worse than no link.
 */
export function WidgetOpenLink({ label, url }: { label: string; url: string }) {
  return (
    <button
      aria-label={label}
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground/40 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover/widget:text-muted-foreground/80"
      /* `openExternal`, not an `<a target="_blank">`: in the Tauri build a
         plain link is swallowed by the webview, and this page ships in both. */
      onClick={() => void openExternal(url)}
      title={label}
      type="button"
    >
      <ExternalLink aria-hidden className="size-3" />
    </button>
  );
}

/** A machine identifier appearing inside a `meta` cell. */
export function WidgetId({ children }: { children: ReactNode }) {
  return <span className="font-mono">{children}</span>;
}

/** The contextual disclosure shown only when this widget has hidden rows. */
export function WidgetMore({ children }: { children: ReactNode }) {
  const disclosure = useContext(WidgetDisclosureContext);
  if (!disclosure) {
    return <span className="text-[10px] text-muted-foreground/70">{children}</span>;
  }
  return (
    <button
      aria-expanded={disclosure.expanded}
      className="self-start rounded-sm text-[10px] text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      data-widget-disclosure-more=""
      onClick={(event) => disclosure.onToggle(event.detail > 0)}
      type="button"
    >
      {children}
    </button>
  );
}

/** An empty state, or the one sentence a widget has when it has no rows. */
export function WidgetNote({ children }: { children: ReactNode }) {
  return <span className="text-[12px] text-muted-foreground">{children}</span>;
}
