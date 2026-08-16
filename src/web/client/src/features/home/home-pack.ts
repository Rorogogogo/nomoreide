import type { HomeLayout } from "@/features/settings/ui-preferences";
import {
  GRID_COLUMNS,
  HOME_ROW_PX,
  moveWidget,
  resolveHomeLayout,
  type DropTarget,
  type PlacedRow,
} from "./home-layout";
import type { WidgetDefinition } from "./widget-types";

/**
 * Where every panel actually sits — the arithmetic CSS grid was doing until it
 * could not.
 *
 * A grid row is as tall as its tallest cell. That is not a bug in the old
 * layout, it is what a row *is*, and it meant a short panel beside a tall one
 * left dead space underneath that nothing could fill: the next row starts below
 * the tallest member, never below the short one. The only way a panel rises into
 * that space is if the page stops being a grid of rows and every panel is placed
 * by hand — which is what this file does.
 *
 * **The rows survive; only `y` changes.** A row still authors reading order,
 * left-to-right position and width, still fills all twelve columns, and is still
 * where a drop and a splitter resize do their work (`home-layout.ts`). What a row
 * no longer decides is how far down its panels start. That is the smallest
 * possible version of the change: everything the layout model guarantees is
 * guaranteed the same way, and one coordinate moved from CSS into here.
 *
 * The placement rule is a **skyline**: each panel, taken in reading order, drops
 * until it lands on the lowest thing already occupying any column it covers.
 * Bottom edges therefore stop lining up — that raggedness is the feature, and it
 * is why this cannot be expressed as rows.
 *
 * Everything here is pure — `(rows, measured heights, column count)` in,
 * rectangles out — so the packing is tested without mounting React, exactly as
 * `home-layout.ts` is. The DOM measuring that feeds it lives in
 * `home-masonry.tsx`, which is the only part that needs a browser.
 */

/**
 * Where the twelve columns stop meaning anything.
 *
 * These are Tailwind's `xl` and `md`, restated as numbers because the placement
 * is now computed rather than expressed in classes. They have to keep matching
 * the breakpoints the rest of the app is built on, so a panel does not change
 * width at a different window size than the sidebar next to it.
 */
export const HOME_WIDE_WIDTH = 1280;
export const HOME_MID_WIDTH = 768;

/**
 * One panel's rectangle: a share of the width, and real pixels down the page.
 *
 * Horizontal in whole columns rather than in pixels or a formatted percentage.
 * Rendering divides them (`panelStyle`) and the drop preview multiplies them
 * back up against the grid's real width, and neither has to parse a CSS string
 * or carry a rounding error the other does not.
 */
export interface PanelPlacement {
  id: string;
  /** Leftmost column, 0-based. */
  column: number;
  /** Width, in columns. */
  span: number;
  /** How many columns there were to divide — the denominator for both. */
  lanes: number;
  /** Pixels from the top of the grid. */
  top: number;
  /** Pixels tall: the stored height, or what the panel measured. */
  height: number;
}

export interface PackedHome {
  placements: PanelPlacement[];
  /** How tall the grid has to be to contain them — its `height`, in px. */
  height: number;
}

/**
 * How many columns there are to divide, at a given container width.
 *
 * Below `xl` the twelfths are useless — there is not enough width for a 4-span
 * panel to hold a stat strip and a row list — so the grid collapses to two
 * columns and then to one, which is exactly what the `md:`/`xl:` classes did
 * before. Masonry keeps working the whole way down: with one column it is a
 * plain stack, which is the correct degenerate case rather than a special one.
 */
export function gridColumns(width: number): number {
  if (width >= HOME_WIDE_WIDTH) return GRID_COLUMNS;
  if (width >= HOME_MID_WIDTH) return 2;
  return 1;
}

/**
 * A stored width, in the columns actually available.
 *
 * The thresholds are the old `SPAN_CLASS` map: anything wider than half the grid
 * took both `md` columns, everything else took one. Keeping the same rule means
 * collapsing the window rearranges the page the way it always did.
 */
export function spanFor(span: number, columns: number): number {
  if (columns >= GRID_COLUMNS) return Math.min(span, columns);
  if (columns === 2) return span >= 7 ? 2 : 1;
  return 1;
}

/**
 * Drop every panel as far up as it will go.
 *
 * `measured` holds what each panel's body actually came out as, by id. It is
 * consulted even for a panel with a stored height, because the stored number is
 * a *request* — the height that ends up on screen is the one the skyline has to
 * stack against, and trusting the request over the measurement is how a panel
 * ends up overlapping the one below it by a pixel.
 *
 * Unmeasured panels fall back to their stored height and then to zero, which is
 * only ever the state of the very first pass, before anything has been laid out.
 */
export function packHome(
  rows: PlacedRow[],
  measured: Record<string, number>,
  columns: number,
): PackedHome {
  const lanes = Math.max(1, Math.floor(columns));
  const skyline = new Array<number>(lanes).fill(0);
  const placements: PanelPlacement[] = [];

  for (const row of rows) {
    // The cursor restarts at each row, which is what keeps the authored rows
    // authored: at twelve columns a row's widths sum to the grid, so the cursor
    // lands back at zero exactly when the row ends. Below `xl` a row of four
    // panels no longer fits on one line and wraps within itself — the same thing
    // its own `grid-cols-2` did, and the reason rows never merge into each other
    // on a narrow window.
    let cursor = 0;
    for (const placed of row.widgets) {
      const span = Math.max(1, Math.min(spanFor(placed.span, lanes), lanes));
      if (cursor + span > lanes) cursor = 0;
      const id = placed.widget.id;
      const height = heightOf(placed.height, measured[id]);

      // The skyline: the panel rests on the lowest thing under *any* column it
      // covers, so a wide panel is held up by whichever narrow one beside it ran
      // longest. Taking the max is the whole of masonry.
      let top = 0;
      for (let lane = cursor; lane < cursor + span; lane += 1) {
        top = Math.max(top, skyline[lane] ?? 0);
      }
      for (let lane = cursor; lane < cursor + span; lane += 1) {
        skyline[lane] = top + height;
      }

      placements.push({ id, column: cursor, span, lanes, top, height });
      cursor += span;
    }
  }

  return { placements, height: Math.max(0, ...skyline) };
}

/**
 * The rectangle a panel would occupy if it were dropped where it is being
 * aimed — the drop's answer, before the drop.
 *
 * It runs the *actual* move against a copy of the layout and packs the result,
 * so what the drag draws and what the release produces are the same arithmetic
 * rather than two implementations that agree until they don't. This is the same
 * bargain `previewSpan` makes for the resize frame, and it is only affordable
 * here because masonry turned placement into a pure function — under CSS grid
 * there was nothing to ask but the browser, and only after committing.
 *
 * One approximation, and it is in the height. `measured` is what the panels are
 * *now*; a panel with no stored height that lands in a narrower slot will wrap
 * more and end up taller than the frame promised. Position and width are exact,
 * which is what the gesture is actually about — re-measuring a panel at a width
 * it does not have yet would mean rendering it twice on every pointermove.
 */
export function previewPlacement(
  widgets: WidgetDefinition[],
  layout: HomeLayout | null,
  id: string,
  target: DropTarget,
  measured: Record<string, number>,
  columns: number,
): PanelPlacement | null {
  const moved = moveWidget(widgets, layout, id, target);
  const packed = packHome(resolveHomeLayout(widgets, moved), measured, columns);
  return packed.placements.find((place) => place.id === id) ?? null;
}

/**
 * What a panel is worth to the skyline.
 *
 * A measurement beats a stored height, and zero is never a measurement — an
 * element that has not been laid out yet reports zero, and treating that as a
 * real height would stack the whole page on top of itself.
 */
function heightOf(stored: number | null, measured: number | undefined): number {
  if (measured !== undefined && measured > 0) return measured;
  return stored === null ? 0 : stored * HOME_ROW_PX;
}
