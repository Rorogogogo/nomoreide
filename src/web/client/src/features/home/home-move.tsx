import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { HomeLayout } from "@/features/settings/ui-preferences";
import { canDropAt, type DropTarget } from "./home-layout";
import { gridColumns, previewPlacement } from "./home-pack";
import { WidgetDragFrame } from "./widget-grid";
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

/** The rectangle the panel would occupy, in viewport coordinates. */
export interface DropPreview {
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
  preview: DropPreview | null;
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

/**
 * Where the cursor is asking for, read off the page.
 *
 * Find the panel being pointed at, then read the gesture against *that panel's*
 * box: near its top or bottom edge means a new row above or below the row it
 * belongs to, and anywhere in between means joining that row on the side of the
 * panel the cursor is on. Comparing against one panel rather than scanning a
 * whole row is both simpler and better aimed — "left half of this one" is what
 * a person dropping a panel beside another one actually means.
 */
function targetAt(x: number, y: number): DropTarget | null {
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
  if (y - rect.top < edge) return { row: hit.row, index: 0, newRow: true };
  if (rect.bottom - y < edge) return { row: hit.row + 1, index: 0, newRow: true };

  const after = x >= rect.left + rect.width / 2;
  return { row: hit.row, index: hit.index + (after ? 1 : 0), newRow: false };
}

/**
 * Every panel's height, taken once.
 *
 * Nothing reflows during a drag, so these are the heights for its whole
 * duration — and reading `offsetHeight` on every pointermove would force layout
 * a hundred times across a gesture to learn the same numbers each time.
 */
function measureHeights(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const cell of document.querySelectorAll<HTMLElement>("[data-widget-cell]")) {
    const id = cell.dataset.widgetCell;
    if (id) out[id] = cell.offsetHeight;
  }
  return out;
}

/**
 * The rectangle the panel will actually occupy, in the viewport.
 *
 * `previewPlacement` runs the real move against a copy of the layout and packs
 * the result, so this is not an approximation of the drop — it is the drop,
 * asked in advance. The grid's own rect is re-read each time rather than cached
 * with the heights, so scrolling mid-drag keeps the frame attached to the page
 * instead of to the screen.
 */
function previewFor(
  widgets: WidgetDefinition[],
  layout: HomeLayout | null,
  id: string,
  target: DropTarget,
  heights: Record<string, number>,
): DropPreview | null {
  const grid = document.querySelector("[data-widget-grid]")?.getBoundingClientRect();
  if (!grid) return null;
  const place = previewPlacement(widgets, layout, id, target, heights, gridColumns(grid.width));
  if (!place) return null;
  return {
    left: grid.left + (place.column / place.lanes) * grid.width,
    top: grid.top + place.top,
    width: (place.span / place.lanes) * grid.width,
    height: place.height,
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
  const heights = useRef<Record<string, number>>({});

  // Same reasoning as the resize grip: a drag that ends anywhere still has to
  // end, and an unmount mid-drag must not leave listeners on the window.
  useEffect(() => () => release.current?.(), []);

  const grab =
    (id: string, title: string) => (event: ReactPointerEvent<HTMLElement>) => {
      /*
        No "is this press on one of the panel's own controls" check any more,
        and it would now reject every drag there is: this hangs off the grip
        button in the panel's header, not off the whole cell.

        That is the point of the handle. The cell used to be draggable in bulk,
        which is why it had to guess whether a press was a drag or a click on
        something inside it — and a panel that is always arrangeable cannot
        guess, because now the thing under the cursor is usually a log line
        someone is trying to select or a tab they are trying to press.
      */
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
          heights.current = measureHeights();
        }
        const found = targetAt(moved.clientX, moved.clientY);
        const target = found && canDropAt(widgets, layout, id, found) ? found : null;
        setMove({
          id,
          title,
          x: moved.clientX,
          y: moved.clientY,
          target,
          // No target, no frame: a drop the layout would refuse — a fifth panel
          // in a row of four — says so by promising nothing, rather than by
          // drawing a rectangle and then not producing it.
          preview: target ? previewFor(widgets, layout, id, target, heights.current) : null,
        });
      };
      const end = (ended: PointerEvent) => {
        release.current?.();
        release.current = null;
        setMove(null);
        if (!started) return;
        const found = targetAt(ended.clientX, ended.clientY);
        if (found && canDropAt(widgets, layout, id, found)) onDrop(id, found);
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
 * What a move looks like while it is happening: the rectangle the panel will
 * occupy, and the panel's name under the cursor.
 *
 * It was a line between two panels, which answered "where in the order" and
 * nothing else — and where in the order is not what a person is deciding. They
 * are deciding what the page will look like, and the two questions come apart
 * here: a drop resizes the panel to its new row's share and moves it to
 * wherever masonry drops it, so the same position in the order can mean very
 * different rectangles. The frame answers the question actually being asked.
 *
 * It is drawn over the untouched page, which is the point: the layout you are
 * comparing against is still the layout you have. So the frame will overlap
 * panels that have not moved yet — the same thing the resize frame does when a
 * panel grows, and honest in the same way, because that space is what this
 * panel is about to take.
 *
 * The name stays under the cursor because the panel being carried does not
 * move — dimming it in place is enough to say which one is in the air, and
 * dragging a full-size copy of a live widget around the page would be a second,
 * laggier rendering of something already on screen.
 */
export function WidgetMoveOverlay({ move }: { move: MoveDrag | null }) {
  if (!move) return null;
  return (
    <>
      <WidgetDragFrame frame={move.preview} />
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
