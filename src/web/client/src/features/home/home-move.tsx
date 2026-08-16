import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { HomeLayout } from "@/features/settings/ui-preferences";
import { canDropAt, type DropTarget } from "./home-layout";
import type { WidgetDefinition } from "./widget-types";

/**
 * Dragging a panel somewhere else.
 *
 * The arrows stay — they are the keyboard's version of this and the only one
 * some people have — but "one place earlier" is a poor way to say *there*, and
 * with rows now stored rather than flowed (`home-layout.ts`) there is finally a
 * *there* to mean: a position in a row, or a row of its own.
 *
 * Same rules as the resize drag next door, for the same reasons: nothing
 * reflows while you are aiming, what moves is an indicator drawn over the
 * untouched page, and the gesture is measured against the DOM rather than
 * against a model of it — the panels are on screen, so their geometry is the
 * truth about where the cursor is.
 *
 * What changed with masonry is *what* it measures. A row used to be an element,
 * and a drop was found by asking which row band the cursor was in. Rows are no
 * longer drawn: their panels stack independently and a row's members can end at
 * different depths, so row bands overlap and "which row is the cursor in" stops
 * having one answer. The drag therefore hit-tests **panels**, which never
 * overlap, and asks whichever one it lands on which row it belongs to.
 */

/** A line drawn where the panel would land, in viewport coordinates. */
export interface DropIndicator {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface MoveDrag {
  id: string;
  title: string;
  /** Cursor position, so the page can label what is being carried. */
  x: number;
  y: number;
  target: DropTarget | null;
  indicator: DropIndicator | null;
}

/** How close to a panel's top or bottom counts as "a new row" rather than "join". */
const EDGE = 16;
/** A press has to travel this far to be a drag, so a click stays a click. */
const THRESHOLD = 5;

/** A placed panel, and the position in the stored layout it stands for. */
interface Cell {
  row: number;
  index: number;
  rect: DOMRect;
}

function cellsOnPage(): Cell[] {
  return [...document.querySelectorAll<HTMLElement>("[data-widget-cell]")].map((cell) => ({
    row: Number(cell.dataset.widgetRow ?? 0),
    index: Number(cell.dataset.widgetIndex ?? 0),
    rect: cell.getBoundingClientRect(),
  }));
}

/**
 * How far the cursor is from a panel — zero when it is inside one.
 *
 * Panels never overlap, so "the nearest panel" answers "which panel is the
 * cursor in" as a special case and keeps working in the ragged space masonry
 * leaves at the bottom of a short column, where the cursor is inside no panel at
 * all and the old row-band search would have found nothing.
 */
function distanceTo(rect: DOMRect, x: number, y: number): number {
  const dx = Math.max(rect.left - x, 0, x - rect.right);
  const dy = Math.max(rect.top - y, 0, y - rect.bottom);
  return dx * dx + dy * dy;
}

/** A new row's line, drawn the full width of the grid at the panel's edge. */
function across(y: number): DropIndicator | null {
  const grid = document.querySelector("[data-widget-grid]")?.getBoundingClientRect();
  if (!grid) return null;
  return { left: grid.left, top: y - 1, width: grid.width, height: 2 };
}

/**
 * Where the cursor is asking for, read off the page.
 *
 * Find the panel being pointed at, then read the gesture against *that panel's*
 * box: near its top or bottom edge means a new row above or below the row it
 * belongs to, and anywhere in between means joining that row on the side of the
 * panel the cursor is on. Comparing against one panel rather than scanning a
 * whole row is both simpler and better aimed — "left half of this one" is what
 * a person dropping a panel beside another one actually means.
 *
 * The line for a new row is drawn at the panel's own edge rather than at the
 * extent of every panel sharing its row. With masonry those are different places
 * — a row's members can end at very different depths — and the useful one is the
 * one under the cursor.
 */
function targetAt(x: number, y: number): { target: DropTarget; indicator: DropIndicator | null } | null {
  const cells = cellsOnPage();
  const hit = cells.reduce<Cell | null>((best, cell) => {
    if (!best) return cell;
    return distanceTo(cell.rect, x, y) < distanceTo(best.rect, x, y) ? cell : best;
  }, null);
  if (!hit) return null;

  const rect = hit.rect;
  // A panel can be as short as two row units, so a fixed 16px band top and
  // bottom would leave almost no middle to mean "join this row". Never more than
  // a third each way.
  const edge = Math.min(EDGE, rect.height / 3);
  if (y - rect.top < edge) {
    return { target: { row: hit.row, index: 0, newRow: true }, indicator: across(rect.top) };
  }
  if (rect.bottom - y < edge) {
    return { target: { row: hit.row + 1, index: 0, newRow: true }, indicator: across(rect.bottom) };
  }

  const after = x >= rect.left + rect.width / 2;
  return {
    target: { row: hit.row, index: hit.index + (after ? 1 : 0), newRow: false },
    indicator: {
      left: (after ? rect.right : rect.left) - 1,
      top: rect.top,
      width: 2,
      height: rect.height,
    },
  };
}

/**
 * The drag itself.
 *
 * Lives in Home rather than in the panel because the indicator has to be drawn
 * outside the grid — the grid hides its own overflow — and because only the
 * page knows the layout the drop will be applied to.
 */
export function useWidgetMove({
  layout,
  onDrop,
  widgets,
}: {
  layout: HomeLayout | null;
  onDrop: (id: string, target: DropTarget) => void;
  widgets: WidgetDefinition[];
}) {
  const [move, setMove] = useState<MoveDrag | null>(null);
  const release = useRef<(() => void) | null>(null);

  // Same reasoning as the resize grip: a drag that ends anywhere still has to
  // end, and an unmount mid-drag must not leave listeners on the window.
  useEffect(() => () => release.current?.(), []);

  const grab =
    (id: string, title: string) => (event: ReactPointerEvent<HTMLElement>) => {
      // The panel's own controls win the press: a remove button inside a
      // draggable panel is still a remove button.
      if ((event.target as HTMLElement).closest("button")) return;
      if (event.button !== 0) return;
      const origin = { x: event.clientX, y: event.clientY };
      let started = false;

      const update = (moved: PointerEvent) => {
        if (
          !started &&
          Math.hypot(moved.clientX - origin.x, moved.clientY - origin.y) < THRESHOLD
        ) {
          return;
        }
        if (!started) {
          started = true;
          document.body.style.cursor = "grabbing";
        }
        const found = targetAt(moved.clientX, moved.clientY);
        const target =
          found && canDropAt(widgets, layout, id, found.target) ? found.target : null;
        setMove({
          id,
          title,
          x: moved.clientX,
          y: moved.clientY,
          target,
          indicator: target ? found?.indicator ?? null : null,
        });
      };
      const end = (ended: PointerEvent) => {
        release.current?.();
        release.current = null;
        setMove(null);
        if (!started) return;
        const found = targetAt(ended.clientX, ended.clientY);
        if (found && canDropAt(widgets, layout, id, found.target)) onDrop(id, found.target);
      };

      window.addEventListener("pointermove", update);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
      release.current = () => {
        document.body.style.cursor = "";
        window.removeEventListener("pointermove", update);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
      };
    };

  return { grab, move };
}

/**
 * What a move looks like while it is happening: a line where the panel will
 * land, and the panel's name under the cursor.
 *
 * The name is there because the panel being carried does not move — dimming it
 * in place is enough to say which one is in the air, and dragging a full-size
 * copy of a live widget around the page would be a second, laggier rendering of
 * something already on screen.
 */
export function WidgetMoveOverlay({ move }: { move: MoveDrag | null }) {
  if (!move) return null;
  return (
    <>
      {move.indicator ? (
        <div
          aria-hidden
          className="pointer-events-none fixed z-50 rounded-full bg-primary"
          style={{
            left: move.indicator.left,
            top: move.indicator.top,
            width: move.indicator.width,
            height: move.indicator.height,
          }}
        />
      ) : null}
      <div
        aria-hidden
        className="pointer-events-none fixed z-50 translate-x-3 translate-y-3 rounded-sm border border-border bg-popover px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground shadow-sm"
        style={{ left: move.x, top: move.y }}
      >
        {move.title}
      </div>
    </>
  );
}
