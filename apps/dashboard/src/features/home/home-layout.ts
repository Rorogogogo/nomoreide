import type { HomeLayout } from "@/features/settings/ui-preferences";
import {
  clampH,
  clampW,
  clampX,
  GRID_COLUMNS,
  type HomeTile,
  HOME_ROW_PX,
  MAX_HEIGHT,
  MIN_HEIGHT,
  MIN_SPAN,
  packTiles,
  rowsForPx,
} from "./home-grid";
import type { WidgetDefinition } from "./widget-types";

export {
  GRID_COLUMNS,
  HOME_ROW_PX,
  MAX_HEIGHT,
  MIN_HEIGHT,
  MIN_SPAN,
  clampH,
  clampW,
  clampX,
  rowsForPx,
};

/**
 * What the user keeps, where, and at what size.
 *
 * Everything here is a pure function of `(registry, storedLayout)`, which is
 * what lets the whole feature be tested without mounting React and keeps Home
 * itself free of layout arithmetic. The stored layout is data from
 * `localStorage` and is treated as such — it never decides *what a widget is*,
 * only which of the registry's widgets are shown, where, and how big.
 *
 * **A panel is a rectangle, not a member of a row.** That is the difference
 * between v5 and everything before it. Named rows made "put this one there"
 * expressible and closed the gap at the end of a short row, but they also put a
 * floor at every row boundary: the empty space beside a tall panel belonged to
 * nobody, and a panel could not be dragged down *through* a row to make the
 * ones there move aside. Both are ordinary things to want, and neither could be
 * written down. Rectangles can say all of it, and `packTiles` resolves them into
 * a page with no overlaps and no holes.
 */

export interface PlacedWidget {
  widget: WidgetDefinition;
  tile: HomeTile;
}

/** Where a drop would put a panel: a cell on the grid, not a slot in a list. */
export interface DropTarget {
  x: number;
  y: number;
}

/**
 * The layout a user who has never touched Home gets.
 *
 * Widgets flow in registry order at their declared width, wrapping when the row
 * they are filling runs out — the same reading order the page has always had,
 * now written as coordinates. No heights: a widget declares a width because a
 * width is a layout decision, but how tall it is is a fact about what it holds.
 */
export function defaultHomeLayout(widgets: WidgetDefinition[]): HomeLayout {
  const tiles: Record<string, HomeTile> = {};
  let x = 0;
  let y = 0;
  for (const widget of widgets) {
    const w = clampW(widget.span, GRID_COLUMNS);
    if (x + w > GRID_COLUMNS) {
      x = 0;
      y += MIN_HEIGHT;
    }
    tiles[widget.id] = { x, y, w, h: null };
    x += w;
  }
  return { tiles };
}

function materialize(widgets: WidgetDefinition[], layout: HomeLayout | null): HomeLayout {
  const base = layout ?? defaultHomeLayout(widgets);
  const tiles: Record<string, HomeTile> = {};
  for (const [id, tile] of Object.entries(base.tiles)) tiles[id] = { ...tile };
  return { tiles };
}

/**
 * The widgets to draw, in reading order, with the rectangle each one wants.
 *
 * Ids the registry no longer knows are dropped rather than rendered as an error
 * (§8.5) — the same quiet failure a stored provider id gets. Reading order is
 * down the page and then across, which is the order `packTiles` resolves in and
 * the order the keyboard walks.
 */
export function resolveHomeLayout(
  widgets: WidgetDefinition[],
  layout: HomeLayout | null,
): PlacedWidget[] {
  const source = layout ?? defaultHomeLayout(widgets);
  const known = new Map(widgets.map((widget) => [widget.id, widget]));
  const placed: PlacedWidget[] = [];
  for (const [id, tile] of Object.entries(source.tiles)) {
    const widget = known.get(id);
    if (widget) placed.push({ widget, tile });
  }
  return placed.sort((a, b) => a.tile.y - b.tile.y || a.tile.x - b.tile.x);
}

/** The registry's widgets that this layout is not showing — the picker's list. */
export function hiddenWidgets(
  widgets: WidgetDefinition[],
  layout: HomeLayout | null,
): WidgetDefinition[] {
  const source = layout ?? defaultHomeLayout(widgets);
  return widgets.filter((widget) => !(widget.id in source.tiles));
}

/** How far down the page anything currently reaches, in rows. */
function bottomOf(tiles: Record<string, HomeTile>): number {
  let bottom = 0;
  for (const tile of Object.values(tiles)) {
    bottom = Math.max(bottom, tile.y + (tile.h ?? MIN_HEIGHT));
  }
  return bottom;
}

/** A new widget arrives at the foot of the page, full width. */
export function addWidget(
  widgets: WidgetDefinition[],
  layout: HomeLayout | null,
  id: string,
): HomeLayout {
  const next = materialize(widgets, layout);
  if (next.tiles[id]) return next;
  next.tiles[id] = { x: 0, y: bottomOf(next.tiles), w: GRID_COLUMNS, h: null };
  return next;
}

export function removeWidget(
  widgets: WidgetDefinition[],
  layout: HomeLayout | null,
  id: string,
): HomeLayout {
  const next = materialize(widgets, layout);
  delete next.tiles[id];
  return next;
}

/**
 * Move a panel to where it was dropped.
 *
 * The drop writes coordinates and nothing else — no rows to splice, no indices
 * to fix up after a removal, and no such thing as an illegal drop, because every
 * cell on the grid is somewhere a rectangle can start. `packTiles` then decides
 * what that means for everyone else: panels the drop landed on move aside if
 * they still fit beside it and below it if they do not.
 *
 * `y` is nudged a half-panel up so a drop reads from the *cursor* rather than
 * from the panel's top edge — a panel grabbed by its middle and dropped over a
 * gap should land in that gap, not one panel-height below it.
 */
export function moveWidget(
  widgets: WidgetDefinition[],
  layout: HomeLayout | null,
  id: string,
  target: DropTarget,
): HomeLayout {
  const next = materialize(widgets, layout);
  const tile = next.tiles[id];
  if (!tile) return next;
  const moved = {
    ...tile,
    x: clampX(target.x, tile.w, GRID_COLUMNS),
    y: Math.max(0, Math.round(target.y)),
  };
  /*
    Rebuilt with the dropped panel first, because reading order breaks a tie by
    stored order and a drop onto an occupied cell is exactly that tie. Leaving
    it where it was in the record means dropping a panel *onto* another one puts
    it after — the page rearranges around a cell you aimed at and then hands it
    to the panel already there. Landing on something is the clearest way there
    is of saying "ahead of this", so the newer intent wins.
  */
  const tiles: Record<string, HomeTile> = { [id]: moved };
  for (const [other, value] of Object.entries(next.tiles)) {
    if (other !== id) tiles[other] = value;
  }
  return { tiles };
}

/**
 * Move a panel one place earlier or later in reading order — the keyboard's
 * version of a drag.
 *
 * Swapping rectangles rather than nudging coordinates: a panel and its
 * neighbour trade places outright, which is the one interpretation that always
 * lands somewhere legible. Stepping a coordinate instead would move a panel a
 * third of the way into its neighbour and let the packer decide the rest, and
 * "press right twice, end up somewhere else" is not a control anyone can use.
 *
 * A drag surface with no keyboard equivalent is a page some people simply
 * cannot rearrange.
 */
export function nudgeWidget(
  widgets: WidgetDefinition[],
  layout: HomeLayout | null,
  id: string,
  delta: -1 | 1,
): HomeLayout {
  const next = materialize(widgets, layout);
  const order = resolveHomeLayout(widgets, next);
  const at = order.findIndex((entry) => entry.widget.id === id);
  const swap = order[at + delta];
  if (at < 0 || !swap) return next;
  const mine = next.tiles[id];
  const theirs = next.tiles[swap.widget.id];
  if (!mine || !theirs) return next;
  next.tiles[id] = { ...mine, x: theirs.x, y: theirs.y };
  next.tiles[swap.widget.id] = { ...theirs, x: mine.x, y: mine.y };
  return next;
}

/**
 * Resize a panel to what its corner was dragged to.
 *
 * A width no longer comes out of the neighbours' pockets — nothing has to give
 * columns up, because a rectangle does not share a row with anyone. A height is
 * free of the row boundary for the same reason: dragging one down past the
 * panels beneath it is a legal thing to ask for, and `packTiles` answers it by
 * moving them aside.
 *
 * `null` clears the height back to fit-to-content, which is what the grip's
 * double-click means.
 */
export function setWidgetSize(
  widgets: WidgetDefinition[],
  layout: HomeLayout | null,
  id: string,
  size: { w?: number; h?: number | null },
): HomeLayout {
  const next = materialize(widgets, layout);
  const tile = next.tiles[id];
  if (!tile) return next;
  const w = size.w === undefined ? tile.w : clampW(size.w, GRID_COLUMNS);
  next.tiles[id] = {
    ...tile,
    w,
    x: clampX(tile.x, w, GRID_COLUMNS),
    h: size.h === undefined ? tile.h : size.h === null ? null : clampH(size.h),
  };
  return next;
}

/** Where every panel actually lands, for a grid this many columns wide. */
export function packLayout(
  placed: PlacedWidget[],
  measuredRows: Record<string, number>,
  columns: number,
) {
  return packTiles(
    placed.map((entry) => ({
      id: entry.widget.id,
      tile: entry.tile,
      measuredRows: measuredRows[entry.widget.id] ?? MIN_HEIGHT,
    })),
    columns,
  );
}
