import { ArrowUpRight, ExternalLink } from "lucide-react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import { openExternal } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { HOME_ROW_PX } from "./home-layout";
import type { PanelPlacement } from "./home-pack";
import { WidgetScroll } from "./widget-scroll";

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

/** What a number or a row *means*, in the fixed vocabulary of `DESIGN.md`. */
export type WidgetTone = "ok" | "warn" | "bad" | "idle";

const TEXT_TONE: Record<WidgetTone, string> = {
  ok: "text-emerald-500",
  warn: "text-amber-500",
  bad: "text-red-500",
  idle: "text-foreground",
};

/**
 * The same hues, faded, for a counter sitting at zero.
 *
 * Tone is a property of *what the counter means*, never of its current value —
 * the "failing" slot stays red whether it reads 2 or 0. That is what lets the
 * labels come off: colour and position carry the meaning instead of a word
 * under every number. Fading the zeros keeps a quiet page quiet, so the one
 * number that isn't zero is the one you see.
 */
const DIM_TONE: Record<WidgetTone, string> = {
  ok: "text-emerald-500/35",
  warn: "text-amber-500/35",
  bad: "text-red-500/35",
  idle: "text-muted-foreground/50",
};

const DOT_TONE: Record<WidgetTone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-red-500",
  idle: "bg-zinc-500/60",
};

/**
 * The grid: a positioned box of a computed height, holding placed panels.
 *
 * It draws no rules of its own — each panel frames itself, which is now the only
 * arrangement possible: with panels stacking independently there is no row whose
 * height a rule could span, and no column whose neighbours are reliably its own
 * height either.
 *
 * `overflow-hidden` is what makes that framing land as one line per seam and no
 * line at all around the outside. `-mr-px` pushes the rightmost column's rule
 * out of view, so the grid ends flush with the panel edge instead of drawing a
 * border down the outside of a full-bleed page; the first row and the first
 * column spend their own outer rules in the pixel this box clips, because every
 * panel is placed a pixel up and a pixel left of its slot (`panelStyle`).
 * Panels are placed in percentages of *this* box, so a panel reaching the last
 * column lands its border in that hidden pixel exactly as a `col-span-12` cell
 * used to.
 *
 * The height is given rather than grown into: every child is absolutely
 * positioned and so contributes nothing to it, and a container that collapsed to
 * zero would take the page's scrollbar with it.
 */
export function WidgetGrid({
  children,
  gridRef,
  height,
}: {
  children: ReactNode;
  gridRef: RefObject<HTMLDivElement | null>;
  height: number;
}) {
  return (
    <div className="overflow-hidden">
      {/*
        `data-widget-grid` is how a resize drag finds the ruler it is measuring
        against: one twelfth of *this* element is one column, whatever the
        window is doing. Reading it off the DOM keeps the measurement where the
        truth is and spares every panel a ref it would otherwise have to thread.
        It is also what the masonry measures itself inside.
      */}
      <div className="relative -mr-px" data-widget-grid="" ref={gridRef} style={{ height }}>
        {children}
      </div>
    </div>
  );
}

/**
 * The cell — a rectangle the packer chose, and the column rule.
 *
 * It was a grid item stretched to its row; it is now absolutely positioned,
 * because a grid row is as tall as its tallest cell and that is precisely the
 * gap masonry exists to close (`home-pack.ts`). What it costs is that the cell
 * no longer knows its own width in CSS — that arrives as a percentage from the
 * packer — and what it buys is that its height is nobody's business but its own.
 *
 * It still carries no padding — that lives in `WidgetBody`, and that split is
 * what lets a panel end where its content does. All four *rules* are the cell's,
 * because they draw the edges of the rectangle the packer chose rather than the
 * edges of what happens to be inside it. That distinction is the whole reason
 * the cell has a height at all: the packer may end a panel a few pixels below
 * its content to bring it level with the one beside it (`home-pack.ts`), and the
 * lines that show it have to follow the slot, not the body.
 *
 * All four, and not the two it used to draw. A bottom-and-right panel is only
 * fully framed if something above it and something to its left happen to be
 * exactly as tall and exactly as wide — and under masonry they routinely are
 * not. A panel beside a shorter neighbour lost its left edge from that
 * neighbour's bottom down; a wide panel under two short ones lost the run of its
 * top edge between them. Drawing its own four edges is the only rule that holds
 * whatever lands next to it.
 *
 * Doubling is avoided by overlap rather than by cleverness (`panelStyle`): each
 * cell is placed a pixel up and a pixel left of its slot and given a pixel more
 * of each dimension, so its top and left rules land *on* the bottom and right
 * rules of whatever it abuts. Every seam is drawn twice into one pixel, and the
 * page's own outside edges fall in the pixel the grid clips.
 *
 * Which also keeps the measuring honest. The body is measured, the cell is
 * placed, and because the body sizes itself the stretch can never be read back
 * as content — a panel that grew to meet its neighbour does not then measure
 * taller and grow again.
 */
export function panelClassName(): string {
  return "group/widget absolute flex flex-col border-t border-b border-l border-border text-left md:border-r";
}

/**
 * The rectangle itself, as inline style.
 *
 * `undefined` is the state before the first measurement — one pass in which the
 * panels are stacked at the top at full width and *at no height at all*, so what
 * that pass measures is the body sizing itself. Giving them a real position
 * there rather than hiding them is what lets it measure something useful instead
 * of measuring a hidden element.
 *
 * The height is the one thing here the packer can change without the content
 * changing: it is what the body measured, plus whatever levelling it onto a
 * neighbour's line cost. Applying it to the cell — never to the body — is what
 * makes that a property of the slot instead of a lie about the content.
 *
 * The pixel it is shifted by is what lets the cell draw all four of its rules
 * without any seam coming out two pixels thick. Starting a pixel early in both
 * axes and running a pixel longer puts the top and left rules exactly where the
 * neighbour above and the neighbour to the left already put their bottom and
 * right ones — the same pixel, painted twice, the same colour. A panel in the
 * first row or the first column spends that pixel outside the grid, which hides
 * it, and that is the full-bleed edge the page has always had.
 *
 * Nothing else in the feature has to know: the shift and the extra pixel are
 * spent entirely on the borders, so the body inside still starts where the slot
 * starts and is still exactly as big as it was — which matters because the drag
 * and the masonry both measure the *body* (`data-widget-body`), never the cell.
 */
export function panelStyle(place: PanelPlacement | undefined): CSSProperties {
  if (!place) return { left: -1, top: -1, width: "calc(100% + 1px)" };
  return {
    height: place.height + 1,
    left: `calc(${(place.column / place.lanes) * 100}% - 1px)`,
    top: place.top - 1,
    width: `calc(${(place.span / place.lanes) * 100}% + 1px)`,
  };
}

/**
 * The dashed rectangle a drag draws over the untouched page: *this is what you
 * will get*.
 *
 * One component for both gestures, because they are making the same promise —
 * a resize says how big, a drop says where and how big, and two frames that
 * looked slightly different would read as two different kinds of answer.
 *
 * Fixed rather than absolute so nothing that clips the grid can clip it: the
 * grid hides its own overflow to keep the rightmost hairline off the page edge,
 * and a frame for a panel at full width has to be allowed past that.
 */
export function WidgetDragFrame({
  frame,
}: {
  frame: { left: number; top: number; width: number; height: number } | null;
}) {
  if (!frame) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed z-50 border border-dashed border-primary/70 bg-primary/5"
      style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
    />
  );
}

/**
 * The padded box a widget draws in: the one a stored height applies to and —
 * because it sizes itself and nothing sizes it — the one the masonry measures.
 *
 * It is no longer the box the resize grip sits in. The grip marks a corner, and
 * the corner anyone can see is the cell's; this box ends wherever the content
 * did, which on a stretched panel is nowhere in particular.
 *
 * `null` is fit-to-content — what every panel did before heights existed and
 * still the default, because how tall a summary needs to be is a fact about
 * what it is currently summarising, not a layout decision anyone should have to
 * make up front. A number is the user's answer, in row units, and it is
 * enforced: asking for less room than the content takes is a legitimate thing
 * to mean, and a panel that silently ignored it would be the resize that "does
 * nothing" all over again.
 *
 * What that used to mean was *clipping*, and it no longer does — the content
 * scrolls inside (`WidgetScroll`). The height still decides the box exactly as
 * before, which is all the packer and the page care about; what changed is that
 * the rest of the content is now reachable instead of destroyed. The
 * `overflow-hidden` here stays regardless: it is what keeps the body a clean
 * rectangle inside the cell's rules, not a scroll policy.
 *
 * Whatever this box comes out as is what the packer stacks the page against, so
 * a panel ending early no longer leaves a hole: the next panel over rises into
 * it. That is the one thing rows could not do and the reason they no longer
 * decide where a panel starts — the height a summary needs is a fact about what
 * it is summarising, and now nothing else is forced to share it.
 *
 * `data-widget-body` is that fact, addressable: it is what gets measured, here
 * and in the drag (`home-move.tsx`). The *cell* is deliberately not, because the
 * cell carries the packer's answer and measuring an answer to recompute it is a
 * loop.
 *
 * `shrink-0` is what keeps it from being one anyway, and it is not decoration.
 * The cell is a flex column with the packed height on it, so by default this box
 * would be *squeezed* to fit — and the cell's own bottom rule takes a pixel of
 * that height, so each pass would measure one pixel less than the last and pack
 * one pixel shorter, forever. Refusing to shrink is what makes the measurement a
 * fact about the content rather than an echo of the last answer.
 */
export function WidgetBody({
  children,
  height,
  id,
}: {
  children: ReactNode;
  height: number | null;
  id: string;
}) {
  return (
    <span
      className="relative flex min-h-0 shrink-0 flex-col gap-2 overflow-hidden px-3 py-2.5"
      data-widget-body={id}
      style={height === null ? undefined : { height: height * HOME_ROW_PX }}
    >
      {children}
    </span>
  );
}

/** The uppercase rule-style header, with whatever the panel puts at its end. */
export function WidgetPanelHeader({
  icon,
  title,
  trailing,
}: {
  icon: ReactNode;
  title: string;
  trailing?: ReactNode;
}) {
  return (
    <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      <span aria-hidden className="[&_svg]:size-3">
        {icon}
      </span>
      {title}
      {trailing}
    </span>
  );
}

/**
 * One widget's cell: header, then whatever the widget knows.
 *
 * The cell is a `<div>` and only the header arrow navigates. It used to be one
 * big `<button>`, so a click anywhere left the page — which made the panel
 * hostile to read: selecting a log line, or reaching for anything inside it,
 * threw you onto another page. A summary you cannot touch without leaving is
 * not a summary.
 *
 * That also lifts the rule this constraint used to impose. A widget may now
 * hold controls of its own, because there is no enclosing button for them to be
 * illegally nested inside. What has *not* changed is the reason behind the old
 * rule: a widget that grows a whole second interface has started becoming a
 * drifting copy of the page it summarises. Controls that pick *what the summary
 * shows* — Logs' tab per service — are the intended kind; controls that act on
 * the world belong on the page the arrow opens.
 *
 * **There is one panel, and it is always the editable one.** Home used to have
 * a mode: a Customize button swapped every cell for a second component that
 * carried the handles. That mode is gone (`home-edit.tsx`), so `controls` and
 * `corner` are slots this fills every time it renders. It still knows nothing
 * about what goes in them — arranging the page belongs to Home, and a widget
 * author reading this file should not find layout editing in it.
 */
export function WidgetPanel({
  children,
  controls,
  corner,
  dragging,
  height,
  icon,
  id,
  index,
  onOpen,
  openLabel,
  place,
  row,
  title,
}: {
  children: ReactNode;
  /** Home's per-panel controls, beside the arrow. */
  controls?: ReactNode;
  /** Home's resize grip, pinned to the corner of the slot the rules draw. */
  corner?: ReactNode;
  dragging?: boolean;
  height: number | null;
  icon: ReactNode;
  id: string;
  /** Position within `row` — the drag's DOM contract, see below. */
  index: number;
  onOpen: () => void;
  openLabel: string;
  place: PanelPlacement | undefined;
  row: number;
  title: string;
}) {
  return (
    <div
      className={cn(
        panelClassName(),
        // Dimmed, not hidden and not carried: the panel stays where it is so
        // the page you are dropping onto is the page you were looking at.
        dragging && "opacity-40 transition-opacity",
      )}
      /*
        The whole DOM contract the move drag reads (`home-move.tsx`). The id is
        also what the masonry keys each measurement by. Rows are not elements —
        masonry lets a row's panels end at different depths, so row bands
        overlap — which is why each panel carries the row it belongs to and the
        drag hit-tests panels instead.
      */
      data-widget-cell={id}
      data-widget-index={index}
      data-widget-row={row}
      style={panelStyle(place)}
    >
      <WidgetBody height={height} id={id}>
        <WidgetPanelHeader
          icon={icon}
          title={title}
          trailing={
            <span className="ml-auto flex items-center gap-0.5">
              {controls}
              <button
                aria-label={openLabel}
                className="rounded-sm text-muted-foreground/40 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/widget:text-muted-foreground"
                onClick={onOpen}
                title={openLabel}
                type="button"
              >
                <ArrowUpRight aria-hidden className="size-3" />
              </button>
            </span>
          }
        />
        <WidgetScroll>{children}</WidgetScroll>
      </WidgetBody>
      {/*
        The grip is the cell's, not the body's: it marks the corner of the
        rectangle you can see, which is the one with the rules around it. Sitting
        on the body it floated wherever the content happened to end — halfway
        down a panel the packer had stretched, with no line beneath it to be the
        corner *of*.
      */}
      {corner}
    </div>
  );
}

/**
 * A row of choices along a hairline — `DESIGN.md`'s "lines, not boxes", so the
 * selected one is marked by the rule thickening under it rather than by a
 * filled pill.
 *
 * These are toggle buttons rather than `role="tab"`: real tabs owe the reader
 * arrow-key navigation and a roving tabindex, and a half-built tablist reads
 * worse to a screen reader than honest buttons do. `aria-pressed` says exactly
 * what is true — one of these is currently chosen.
 */
export function WidgetTabs({ children }: { children: ReactNode }) {
  return (
    <span className="flex flex-wrap items-center gap-3 border-b border-border">{children}</span>
  );
}

export function WidgetTab({
  active,
  children,
  onSelect,
}: {
  active: boolean;
  children: ReactNode;
  onSelect: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        "-mb-px border-b pb-1 font-mono text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "border-foreground text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
      onClick={onSelect}
      type="button"
    >
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
  return (
    <span className="flex flex-wrap items-center divide-x divide-border">{children}</span>
  );
}

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
        `DESIGN.md` warns about for long branch names.
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
      className="shrink-0 rounded-sm text-muted-foreground/40 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover/widget:text-muted-foreground/80"
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

/** The "and 14 others" line that keeps a row list from becoming a log. */
export function WidgetMore({ children }: { children: ReactNode }) {
  return <span className="text-[10px] text-muted-foreground/70">{children}</span>;
}

/** An empty state, or the one sentence a widget has when it has no rows. */
export function WidgetNote({ children }: { children: ReactNode }) {
  return <span className="text-[12px] text-muted-foreground">{children}</span>;
}
