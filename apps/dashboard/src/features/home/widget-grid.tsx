import { ArrowUpRight, ExternalLink } from "lucide-react";
import {
  createContext,
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Loading } from "@/components/ui/loading";
import { openExternal } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import type { WidgetTone } from "./widget-tone";
import { DOT_TONE } from "./widget-tone";
import {
  WidgetDisclosureContext,
  WidgetStatsDockContext,
} from "./widget-context";

// The feature's public component library: the container lives here and the
// pieces that go inside a widget stay re-exported, so a widget imports once.
export * from "./widget-content";
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
 * The look is `docs/DESIGN.md`: **lines, not boxes.** Nothing here draws a card.
 */

/** What a number or a row *means*, in the fixed vocabulary of `docs/DESIGN.md`. */
export type { WidgetTone } from "./widget-tone";


/** Room for a title, three counters, and Home's panel controls without overlap. */
const HEADER_STATS_MIN_WIDTH = 400;

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
      <div
        className="relative -mr-px"
        data-widget-grid=""
        ref={gridRef}
        style={{ height }}
      >
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
 * drifting copy of the page it summarises. Small, contextual controls are fine
 * when they complete the row's obvious task — for example starting or stopping
 * a named service — while configuration and multi-step workflows stay on the
 * page the arrow opens.
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
  expanded = false,
  height,
  icon,
  id,
  lessLabel,
  onDisclosureToggle,
  onOpen,
  openLabel,
  place,
  title,
  transitioning = false,
}: {
  children: ReactNode;
  /** Home's per-panel controls, beside the arrow. */
  controls?: ReactNode;
  /** Home's resize grip, pinned to the corner of the slot the rules draw. */
  corner?: ReactNode;
  dragging?: boolean;
  expanded?: boolean;
  height: number | null;
  icon: ReactNode;
  id: string;
  lessLabel: string;
  onDisclosureToggle: (animate: boolean) => void;
  onOpen: () => void;
  openLabel: string;
  place: PanelPlacement | undefined;
  title: string;
  transitioning?: boolean;
}) {
  const style = panelStyle(place);
  const panel = useRef<HTMLDivElement | null>(null);
  const statsTarget = useRef<HTMLSpanElement | null>(null);
  const [statsDocked, setStatsDocked] = useState(false);
  const focusAfterToggle = useRef<"less" | "more" | null>(null);

  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const update = () => setStatsDocked(element.clientWidth >= HEADER_STATS_MIN_WIDTH);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const target = focusAfterToggle.current;
    if (!target) return;
    focusAfterToggle.current = null;
    panel.current
      ?.querySelector<HTMLButtonElement>(`[data-widget-disclosure-${target}]`)
      ?.focus();
  }, [expanded]);

  const toggleDisclosure = (animate: boolean) => {
    if (!animate) focusAfterToggle.current = expanded ? "more" : "less";
    onDisclosureToggle(animate);
  };

  return (
    <div
      className={cn(
        panelClassName(),
        // Dimmed, not hidden and not carried: the panel stays where it is so
        // the page you are dropping onto is the page you were looking at.
        dragging && "opacity-40 transition-opacity",
      )}
      /*
        The id the masonry keys each measurement by, and what the move drag
        measures the grab offset against. There is no row or index to carry any
        more: a panel is a rectangle on the grid, and the drag reads the grid
        itself rather than hit-testing its neighbours.
      */
      data-widget-cell={id}
      ref={panel}
      style={transitioning ? { ...style, viewTransitionName: "home-widget-disclosure" } : style}
    >
      <WidgetBody height={height} id={id}>
        <WidgetStatsDockContext.Provider
          value={{ docked: statsDocked, target: statsTarget.current }}
        >
          <WidgetPanelHeader
            icon={icon}
            title={title}
            trailing={
              <>
                <span
                  aria-hidden={!statsDocked}
                  className="ml-auto flex shrink-0 items-center"
                  ref={statsTarget}
                />
                <span className="flex items-center gap-0.5">
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
              </>
            }
          />
          <WidgetDisclosureContext.Provider
            value={{ expanded, onToggle: toggleDisclosure }}
          >
            <WidgetScroll>{children}</WidgetScroll>
            {expanded ? (
              <button
                aria-expanded={true}
                className="self-start rounded-sm text-[10px] text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                data-widget-disclosure-less=""
                onClick={(event) => toggleDisclosure(event.detail > 0)}
                type="button"
              >
                {lessLabel}
              </button>
            ) : null}
          </WidgetDisclosureContext.Provider>
        </WidgetStatsDockContext.Provider>
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
 * A row of choices along a hairline — `docs/DESIGN.md`'s "lines, not boxes", so the
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
 * `docs/DESIGN.md` again, and the reason nothing here is 24px: a dashboard number is
 * read against its neighbours, so three 13px figures beat one large one.
 */
export function WidgetStats({ children }: { children: ReactNode }) {
  const dock = useContext(WidgetStatsDockContext);
  const stats = (
    <span className="flex flex-wrap items-center divide-x divide-border">{children}</span>
  );
  return dock?.docked && dock.target ? createPortal(stats, dock.target) : stats;
}

/** The app's existing wave loader, sized for a compact dashboard panel. */
export function WidgetLoading({ label }: { label: string }) {
  return <Loading className="min-h-12 py-1" label={label} />;
}
