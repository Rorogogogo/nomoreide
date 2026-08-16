import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { PlacedRow } from "./home-layout";
import { gridColumns, packHome, type PanelPlacement } from "./home-pack";

/**
 * The measuring half of the masonry: the part that needs a browser.
 *
 * `home-pack.ts` can place a panel given its height. Only the DOM knows what
 * that height *is* — a panel with no stored height is as tall as what it holds,
 * which is the default and the right one, so the page cannot be laid out without
 * first asking it. That is the real price of leaving CSS grid: the layout is now
 * measure-then-place instead of one pass of the browser's own solver.
 *
 * Three things keep that from being a mess:
 *
 * - **Only `top` is measured.** `left` and `width` are percentages of the grid,
 *   derived from the column count alone, so a window resize needs no
 *   remeasurement to stay pixel-exact and the horizontal layout is never wrong
 *   between passes.
 * - **`useLayoutEffect`, so nothing is ever painted mid-solve.** Measurement runs
 *   after the DOM is written and before the browser draws, and the state update
 *   it makes is flushed in the same frame. A settling pass exists but is never
 *   seen.
 * - **A signature guard, so it terminates.** Placing a panel changes where it is,
 *   never how tall it is, so the pass after the one that moved things measures
 *   the same numbers and stops. The guard is what turns that argument into a
 *   guarantee rather than a hope.
 */

export interface HomeMasonry {
  /** The positioned container everything is measured inside and placed against. */
  grid: RefObject<HTMLDivElement | null>;
  /** Where each panel goes, by widget id. Empty until the first measurement. */
  boxes: Map<string, PanelPlacement>;
  /** How tall the container must be to hold them, in px. */
  height: number;
}

export function useHomeMasonry(rows: PlacedRow[]): HomeMasonry {
  const grid = useRef<HTMLDivElement | null>(null);
  const [packed, setPacked] = useState<{ boxes: Map<string, PanelPlacement>; height: number }>(
    () => ({ boxes: new Map(), height: 0 }),
  );

  /*
    The rows are recomputed from preferences on every render, so they are a new
    array every time even when nothing about them changed. Reading them through a
    ref keeps `measure` stable, which is what lets the observer below be attached
    once for a set of widgets rather than torn down and rebuilt every frame.
  */
  const latest = useRef(rows);
  latest.current = rows;
  const signature = useRef("");

  const measure = useCallback(() => {
    const container = grid.current;
    if (!container) return;
    const width = container.getBoundingClientRect().width;
    const measured: Record<string, number> = {};
    for (const cell of container.querySelectorAll<HTMLElement>("[data-widget-cell]")) {
      const id = cell.dataset.widgetCell;
      // `offsetHeight` rather than the rect: it is a whole number, and a
      // fractional height read back through the skyline is how a measure-place
      // loop starts oscillating between two positions a hundredth of a pixel
      // apart. A rounded pixel of overlap is invisible; a loop is not.
      if (id) measured[id] = cell.offsetHeight;
    }

    const next = packHome(latest.current, measured, gridColumns(width));
    const key = `${width}|${next.height}|${next.placements
      .map((place) => `${place.id}:${place.left}:${place.width}:${place.top}`)
      .join(",")}`;
    if (key === signature.current) return;
    signature.current = key;
    setPacked({
      boxes: new Map(next.placements.map((place) => [place.id, place])),
      height: next.height,
    });
  }, []);

  // Every render, deliberately: a widget's content changes with each poll of the
  // dashboard, and a panel that grew a row has to be restacked. The guard above
  // makes the no-op case a few reads and no re-render.
  useLayoutEffect(measure);

  /*
    Content can also change without Home re-rendering — a widget's own fetch
    resolving, a font landing, a container query. Observing the panels catches
    those; observing the container catches the window resize that changes the
    column count. Re-attached when the set of widgets changes, which is the only
    time the list of elements to watch is different.
  */
  const watched = rows.flatMap((row) => row.widgets.map((placed) => placed.widget.id)).join(",");
  useEffect(() => {
    const container = grid.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    for (const cell of container.querySelectorAll<HTMLElement>("[data-widget-cell]")) {
      observer.observe(cell);
    }
    return () => observer.disconnect();
  }, [measure, watched]);

  return { grid, boxes: packed.boxes, height: packed.height };
}
