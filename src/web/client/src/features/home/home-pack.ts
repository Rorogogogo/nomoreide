import type { HomeLayout } from "@/features/settings/ui-preferences";
import { GRID_COLUMNS, HOME_ROW_PX, MIN_SPAN, type TilePlacement } from "./home-grid";
import {
  type DropTarget,
  moveWidget,
  type PlacedWidget,
  packLayout,
  resolveHomeLayout,
  setWidgetSize,
} from "./home-layout";
import type { WidgetDefinition } from "./widget-types";

/**
 * The grid in pixels.
 *
 * `home-grid.ts` decides everything in whole columns and rows, because that is
 * the only unit in which "is this space free" has an exact answer. This is the
 * one place that turns those integers into the numbers a stylesheet wants, so
 * nothing above it has to know that a row is 32 pixels.
 */

/**
 * Below these the grid gives up columns rather than shrinking them: a panel at
 * three of twelve columns on a phone is a column of text one word wide.
 */
export const HOME_WIDE_WIDTH = 1280;
export const HOME_MID_WIDTH = 768;

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
  /** Pixels tall. */
  height: number;
}

export interface PackedHome {
  placements: PanelPlacement[];
  /** How tall the grid has to be to contain them — its `height`, in px. */
  height: number;
}

/** How many columns there are to divide, at a given container width. */
export function gridColumns(width: number): number {
  if (width >= HOME_WIDE_WIDTH) return GRID_COLUMNS;
  if (width >= HOME_MID_WIDTH) return GRID_COLUMNS / 2;
  return MIN_SPAN;
}

function toPixels(placements: TilePlacement[], lanes: number): PackedHome {
  let deepest = 0;
  const out: PanelPlacement[] = [];
  for (const place of placements) {
    deepest = Math.max(deepest, place.y + place.h);
    out.push({
      id: place.id,
      column: place.x,
      span: place.w,
      lanes,
      top: place.y * HOME_ROW_PX,
      height: place.h * HOME_ROW_PX,
    });
  }
  return { placements: out, height: deepest * HOME_ROW_PX };
}

/** Where every panel lands, in pixels, for a grid this many columns wide. */
export function packHome(
  placed: PlacedWidget[],
  measuredRows: Record<string, number>,
  columns: number,
): PackedHome {
  const lanes = Math.max(1, Math.min(GRID_COLUMNS, Math.floor(columns)));
  return toPixels(packLayout(placed, measuredRows, lanes), lanes);
}

/**
 * Where a panel would sit if it were the width the drag is asking for.
 *
 * Running the request through the same packer the drop will use is what keeps
 * the frame from promising something that will not survive the release — the
 * *position* as much as the width, since a panel that has to narrow to fit
 * beside a tall neighbour moves as well as shrinks.
 */
export function previewResize(
  widgets: WidgetDefinition[],
  layout: HomeLayout | null,
  id: string,
  w: number,
  measuredRows: Record<string, number>,
  columns: number,
): PanelPlacement | null {
  const sized = setWidgetSize(widgets, layout, id, { w });
  const packed = packHome(resolveHomeLayout(widgets, sized), measuredRows, columns);
  return packed.placements.find((place) => place.id === id) ?? null;
}

/**
 * Where a panel would land if it were dropped here, and what that does to it.
 *
 * The same packer the drop will use, so the frame promises exactly what the
 * release produces — including a width the panel does not currently have, since
 * a rectangle dropped beside a tall neighbour narrows to the space that is
 * actually free there.
 */
export function previewMove(
  widgets: WidgetDefinition[],
  layout: HomeLayout | null,
  id: string,
  target: DropTarget,
  measuredRows: Record<string, number>,
  columns: number,
): PanelPlacement | null {
  const moved = moveWidget(widgets, layout, id, target);
  const packed = packHome(resolveHomeLayout(widgets, moved), measuredRows, columns);
  return packed.placements.find((place) => place.id === id) ?? null;
}
