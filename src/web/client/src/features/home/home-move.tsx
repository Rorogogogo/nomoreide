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
 * against a model of it — the rows are on screen, so their geometry is the
 * truth about where the cursor is.
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

/** How close to a row's edge counts as "between the rows" rather than "in it". */
const EDGE = 16;
/** A press has to travel this far to be a drag, so a click stays a click. */
const THRESHOLD = 5;

function rowsOnPage(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-widget-row]")];
}

/** The line between two rows, drawn the full width of the grid. */
function betweenRows(rows: HTMLElement[], at: number): DropIndicator | null {
  const grid = document.querySelector("[data-widget-grid]")?.getBoundingClientRect();
  if (!grid) return null;
  const edge =
    at === 0
      ? (rows[0]?.getBoundingClientRect().top ?? grid.top)
      : (rows[Math.min(at, rows.length) - 1]?.getBoundingClientRect().bottom ?? grid.bottom);
  return { left: grid.left, top: edge - 1, width: grid.width, height: 2 };
}

/**
 * Where the cursor is asking for, read off the page.
 *
 * Vertically first: near a row's top or bottom edge means a new row, anywhere
 * else in the band means joining that row. Then horizontally, by comparing the
 * cursor against each panel's midpoint — the same rule every list-reorder in
 * the world uses, and the one that makes the indicator land where the eye
 * expects when the cursor is between two panels of different widths.
 */
function targetAt(x: number, y: number): { target: DropTarget; indicator: DropIndicator | null } | null {
  const rows = rowsOnPage();
  if (!rows.length) return null;

  const bands = rows.map((row) => row.getBoundingClientRect());
  const index = bands.findIndex((band) => y >= band.top && y <= band.bottom);
  if (index < 0) {
    // Above the page or below it — the two places a new row is obviously meant.
    const at = y < (bands[0]?.top ?? 0) ? 0 : rows.length;
    return { target: { row: at, index: 0, newRow: true }, indicator: betweenRows(rows, at) };
  }

  const band = bands[index] as DOMRect;
  if (y - band.top < EDGE) {
    return { target: { row: index, index: 0, newRow: true }, indicator: betweenRows(rows, index) };
  }
  if (band.bottom - y < EDGE) {
    const at = index + 1;
    return { target: { row: at, index: 0, newRow: true }, indicator: betweenRows(rows, at) };
  }

  const cells = [...(rows[index]?.querySelectorAll<HTMLElement>("[data-widget-cell]") ?? [])];
  const boxes = cells.map((cell) => cell.getBoundingClientRect());
  let at = boxes.length;
  for (const [cell, box] of boxes.entries()) {
    if (x < box.left + box.width / 2) {
      at = cell;
      break;
    }
  }
  const edge = at < boxes.length ? boxes[at]?.left : boxes.at(-1)?.right;
  return {
    target: { row: index, index: at, newRow: false },
    indicator:
      edge === undefined ? null : { left: edge - 1, top: band.top, width: 2, height: band.height },
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
