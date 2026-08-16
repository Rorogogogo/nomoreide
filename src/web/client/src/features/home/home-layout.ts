import type { HomeLayout } from "@/features/settings/ui-preferences";
import type { WidgetDefinition, WidgetSpan } from "./widget-types";

/**
 * What the user keeps, in what rows, at what size.
 *
 * Everything here is a pure function of `(registry, storedLayout)`, which is
 * what lets the whole feature be tested without mounting React and keeps Home
 * itself free of layout arithmetic. The stored layout is data from
 * `localStorage` and is treated as such — it never decides *what a widget is*,
 * only which of the registry's widgets are shown, where, and how big.
 *
 * **A row always fills the grid.** That is the invariant every function here
 * maintains and `fitRow` restores, and it is not cosmetic: a flowing list wraps
 * wherever the next widget stops fitting, so a row whose leftover was narrower
 * than the next widget wanted ended in dead space nobody asked for. Naming the
 * rows makes the gap unrepresentable — a widget removed, dropped in, or dragged
 * narrower hands its columns to the row it is in, because there is nowhere else
 * for them to go.
 */

/** The grid a width is measured in, and the narrowest panel worth having. */
export const GRID_COLUMNS = 12;
export const MIN_SPAN = 3;
/** Four panels of three columns; a fifth could not have a legible width. */
export const MAX_ROW_WIDGETS = GRID_COLUMNS / MIN_SPAN;

/**
 * The vertical ruler.
 *
 * Columns are a fraction of the window and so need no unit; rows cannot be —
 * there is no page height to divide, because Home scrolls. So a height is a
 * count of fixed 32px units, which is what makes two panels dragged to "4"
 * actually line up.
 */
export const HOME_ROW_PX = 32;
export const MIN_HEIGHT = 2;
export const MAX_HEIGHT = 12;

export interface PlacedWidget {
  widget: WidgetDefinition;
  span: WidgetSpan;
  /** Row units, or `null` for a panel that is as tall as what it holds. */
  height: number | null;
}

/** One row of the page: panels left to right, widths summing to `GRID_COLUMNS`. */
export interface PlacedRow {
  widgets: PlacedWidget[];
}

/** Where a dragged widget is going: an index in a row, or a row of its own. */
export interface DropTarget {
  row: number;
  /** Position within that row. Ignored when `newRow` is set. */
  index: number;
  /** Insert a new row *before* `row` rather than joining it. */
  newRow: boolean;
}

function clamp(value: number, min: number, max: number): number {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded)) return min;
  return Math.min(max, Math.max(min, rounded));
}

/** Any column count a drag can produce, pulled back into the legal range. */
export function clampSpan(columns: number): WidgetSpan {
  return clamp(columns, MIN_SPAN, GRID_COLUMNS) as WidgetSpan;
}

/** The same, vertically. */
export function clampHeight(rows: number): number {
  return clamp(rows, MIN_HEIGHT, MAX_HEIGHT);
}

function isHeight(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_HEIGHT &&
    value <= MAX_HEIGHT
  );
}

/**
 * Make a row's widths add up to the grid, in place.
 *
 * The invariant's enforcer. Columns are handed to the narrowest panel and taken
 * from the widest, one at a time, so the row stays as close to the proportions
 * it was given as an integer grid allows: `[4, 4]` becomes `[6, 6]` rather than
 * `[8, 4]`, and a row that already fills is left exactly alone.
 */
function fitRow(row: string[], spans: Record<string, number>): void {
  if (!row.length) return;
  for (const id of row) spans[id] = clampSpan(spans[id] ?? MIN_SPAN);
  let sum = row.reduce((total, id) => total + (spans[id] ?? 0), 0);
  const pick = (widest: boolean) =>
    row.reduce((best, id) =>
      (widest ? (spans[id] ?? 0) > (spans[best] ?? 0) : (spans[id] ?? 0) < (spans[best] ?? 0))
        ? id
        : best,
    );
  while (sum < GRID_COLUMNS) {
    const id = pick(false);
    spans[id] = (spans[id] ?? MIN_SPAN) + 1;
    sum += 1;
  }
  while (sum > GRID_COLUMNS) {
    const id = pick(true);
    if ((spans[id] ?? 0) <= MIN_SPAN) break;
    spans[id] = (spans[id] ?? MIN_SPAN) - 1;
    sum -= 1;
  }
}

/**
 * The registry's own order and declared widths, packed into rows — the
 * "example" layout every install starts from, and what Reset returns to.
 *
 * It is derived rather than stored, so a widget added in a later release shows
 * up for everyone who has never customised Home instead of requiring a
 * migration to inject an id into their saved layout.
 */
export function defaultHomeLayout(widgets: WidgetDefinition[]): HomeLayout {
  const rows: string[][] = [];
  const spans: Record<string, number> = {};
  let used = GRID_COLUMNS;
  for (const widget of widgets) {
    const want = clampSpan(widget.span);
    if (used + want > GRID_COLUMNS || (rows.at(-1)?.length ?? 0) >= MAX_ROW_WIDGETS) {
      rows.push([]);
      used = 0;
    }
    rows.at(-1)?.push(widget.id);
    spans[widget.id] = want;
    used += want;
  }
  for (const row of rows) fitRow(row, spans);
  // No heights: a widget declares a width because a width is a layout decision,
  // but how tall it is is a fact about what it currently holds.
  return { rows, spans, heights: {} };
}

/**
 * What Home actually draws.
 *
 * A `null` layout means "never customised" and follows the registry. A stored
 * one names ids, and an id the registry no longer knows is **dropped silently**
 * (§8.5) — a widget removed in a later release must not turn a saved layout
 * into an error message on the landing page. Its columns go to the rest of its
 * row, which is the gap-free version of the same rule.
 */
export function resolveHomeLayout(
  widgets: WidgetDefinition[],
  layout: HomeLayout | null,
): PlacedRow[] {
  const byId = new Map(widgets.map((widget) => [widget.id, widget]));
  const source = layout ?? defaultHomeLayout(widgets);
  const spans: Record<string, number> = { ...source.spans };
  const placed: PlacedRow[] = [];
  for (const row of source.rows) {
    const known = row.filter((id) => byId.has(id));
    // A stored row wider than four panels cannot be drawn legibly, so the
    // overflow becomes its own row rather than a line of slivers.
    for (let at = 0; at < known.length; at += MAX_ROW_WIDGETS) {
      const ids = known.slice(at, at + MAX_ROW_WIDGETS);
      for (const id of ids) spans[id] ??= byId.get(id)?.span ?? MIN_SPAN;
      fitRow(ids, spans);
      placed.push({
        widgets: ids.map((id) => {
          const height = source.heights?.[id];
          return {
            // Non-null by construction: `known` kept only registered ids.
            widget: byId.get(id) as WidgetDefinition,
            span: spans[id] as WidgetSpan,
            height: isHeight(height) ? height : null,
          };
        }),
      });
    }
  }
  return placed;
}

/** The widgets a picker can offer: registered, and not currently placed. */
export function hiddenWidgets(
  widgets: WidgetDefinition[],
  layout: HomeLayout | null,
): WidgetDefinition[] {
  if (!layout) return [];
  const shown = new Set(layout.rows.flat());
  return widgets.filter((widget) => !shown.has(widget.id));
}

/**
 * Every edit starts by materialising the default.
 *
 * The first change a user makes is also the moment their layout stops tracking
 * the registry. Writing the whole thing at that point is what makes the rest of
 * the operations plain array arithmetic, and what makes "I removed everything"
 * storable at all.
 */
function materialize(widgets: WidgetDefinition[], layout: HomeLayout | null): HomeLayout {
  const source = layout ?? defaultHomeLayout(widgets);
  const next = {
    rows: source.rows.map((row) => [...row]),
    spans: { ...source.spans },
    heights: { ...source.heights },
  };
  // Fit before editing, so the numbers being edited are the ones on screen. A
  // layout can arrive here not filling — migrated from v3, or written before a
  // widget was retired — and `resolveHomeLayout` fixes that for the render
  // without writing it back. Editing from the stored value instead would take
  // the panel's width from a number the user has never seen.
  for (const row of next.rows) fitRow(row, next.spans);
  return next;
}

/** Where a widget currently is, or `null` if this layout does not show it. */
function locate(layout: HomeLayout, id: string): { row: number; index: number } | null {
  for (const [row, ids] of layout.rows.entries()) {
    const index = ids.indexOf(id);
    if (index >= 0) return { row, index };
  }
  return null;
}

/** Take a widget out, hand its columns to the rest of its row, drop empty rows. */
function detach(layout: HomeLayout, id: string): void {
  const at = locate(layout, id);
  if (!at) return;
  const row = layout.rows[at.row] as string[];
  row.splice(at.index, 1);
  if (row.length) fitRow(row, layout.spans);
  else layout.rows.splice(at.row, 1);
}

/** Put a widget into a row, taking its columns from the panels already there. */
function attach(layout: HomeLayout, id: string, row: string[], index: number): void {
  row.splice(Math.max(0, Math.min(index, row.length)), 0, id);
  // An even share to start with: a widget arriving into a row of one lands at
  // half of it, not at whatever width it happened to have somewhere else.
  layout.spans[id] = Math.max(MIN_SPAN, Math.floor(GRID_COLUMNS / row.length));
  for (const other of row) {
    if (other !== id) layout.spans[other] = Math.max(MIN_SPAN, layout.spans[other] ?? MIN_SPAN);
  }
  fitRow(row, layout.spans);
}

/** A new widget arrives as a row of its own, full width. */
export function addWidget(
  widgets: WidgetDefinition[],
  layout: HomeLayout | null,
  id: string,
): HomeLayout {
  const next = materialize(widgets, layout);
  if (locate(next, id)) return next;
  next.rows.push([id]);
  next.spans[id] = GRID_COLUMNS;
  return next;
}

export function removeWidget(
  widgets: WidgetDefinition[],
  layout: HomeLayout | null,
  id: string,
): HomeLayout {
  const next = materialize(widgets, layout);
  detach(next, id);
  // The height override outlives the removal on purpose: put the widget back
  // and it returns at the height you had chosen for it. The width cannot — it
  // is a share of whichever row it lands in next.
  return next;
}

/** Whether a drop would be legal, so the drag can refuse to draw an indicator. */
export function canDropAt(
  widgets: WidgetDefinition[],
  layout: HomeLayout | null,
  id: string,
  target: DropTarget,
): boolean {
  if (target.newRow) return true;
  const row = (layout ?? defaultHomeLayout(widgets)).rows[target.row];
  if (!row) return false;
  return row.includes(id) || row.length < MAX_ROW_WIDGETS;
}

/**
 * Move a widget to where it was dropped.
 *
 * Rows are removed and inserted as the widget leaves and arrives, so a drag can
 * empty a row, create one, or reorder within one — the three things a person
 * means by dragging a panel somewhere.
 */
export function moveWidget(
  widgets: WidgetDefinition[],
  layout: HomeLayout | null,
  id: string,
  target: DropTarget,
): HomeLayout {
  const next = materialize(widgets, layout);
  const from = locate(next, id);
  if (!from || !canDropAt(widgets, next, id, target)) return next;
  const destination = next.rows[target.row];

  // Row *indices* cannot survive the removal — taking the widget out may delete
  // the row it was alone in and shift everything after it — so both branches
  // below hold on to the destination by identity instead.
  if (target.newRow) {
    // Giving a widget a row of its own directly above or below the row it
    // already has to itself is the one drop that means nothing.
    if (destination?.length === 1 && destination[0] === id) return next;
    const anchor = destination?.find((other) => other !== id) ?? null;
    detach(next, id);
    const at = anchor ? next.rows.findIndex((row) => row.includes(anchor)) : -1;
    next.rows.splice(at < 0 ? next.rows.length : at, 0, [id]);
    next.spans[id] = GRID_COLUMNS;
    return next;
  }

  if (!destination) return next;
  // Removing the widget from earlier in the same row shifts the drop one left.
  const sameRow = from.row === target.row;
  const index = sameRow && from.index < target.index ? target.index - 1 : target.index;
  detach(next, id);
  if (!next.rows.includes(destination)) return next;
  attach(next, id, destination, index);
  return next;
}

/**
 * Move a widget one place earlier or later — the keyboard's version of a drag.
 *
 * It walks the page in reading order, so at a row's edge it steps into the
 * neighbouring row rather than stopping. A drag surface that has no keyboard
 * equivalent is a layout some users of this page simply cannot rearrange.
 */
export function nudgeWidget(
  widgets: WidgetDefinition[],
  layout: HomeLayout | null,
  id: string,
  delta: -1 | 1,
): HomeLayout {
  const next = materialize(widgets, layout);
  const at = locate(next, id);
  if (!at) return next;
  const row = next.rows[at.row] as string[];
  const within = at.index + delta;
  if (within >= 0 && within < row.length) {
    row.splice(within, 0, ...row.splice(at.index, 1));
    return next;
  }
  const neighbour = at.row + delta;
  if (neighbour < 0 || neighbour >= next.rows.length) return next;
  const target = next.rows[neighbour] as string[];
  if (target.length >= MAX_ROW_WIDGETS) return next;
  return moveWidget(widgets, next, id, {
    row: neighbour,
    index: delta === 1 ? 0 : target.length,
    newRow: false,
  });
}

/**
 * Commit a drag: a width, a height, or — from the corner grip — both.
 *
 * Both in one call rather than two setters chained, because each call is a
 * separate write to preferences and a corner drag that landed as two writes
 * would be two entries of layout history for one gesture, with a frame in
 * between where the panel is its new width at its old height.
 *
 * A `null` height is the erasure, not a zero: it drops the override and hands
 * the panel back to its content.
 */
export function setWidgetSize(
  widgets: WidgetDefinition[],
  layout: HomeLayout | null,
  id: string,
  size: { span?: WidgetSpan; height?: number | null },
): HomeLayout {
  const next = materialize(widgets, layout);
  if (size.span !== undefined) resize(next, id, size.span);
  if (size.height !== undefined) {
    const heights = { ...next.heights };
    if (size.height === null) delete heights[id];
    else heights[id] = clampHeight(size.height);
    next.heights = heights;
  }
  return next;
}

/**
 * Widen or narrow a panel, in place, at its row's expense.
 *
 * The columns have to come from somewhere and the row is where — this is the
 * splitter the agent dock has, generalised to a row of panels. Neighbours give
 * up columns nearest-first and never below `MIN_SPAN`.
 *
 * Which used to be the end of it, and made the whole grid unreachable: a panel
 * sharing with one neighbour stopped at nine columns, so a drag to the right
 * edge of the page came back three quarters wide and every further pixel did
 * nothing. The cap is the right answer for every width *except* the one that
 * says the neighbours should not be in this row at all. So asking for all twelve
 * is now a different request, not a bigger one: the panel takes the row and its
 * neighbours drop to a row of their own, in the order they were already in.
 *
 * That keeps `MIN_SPAN` meaning what it says — no panel is ever squeezed below a
 * quarter of the grid — while leaving full width somewhere a pointer can reach.
 */
function resize(layout: HomeLayout, id: string, span: WidgetSpan): void {
  const at = locate(layout, id);
  if (!at) return;
  const row = layout.rows[at.row] as string[];
  const others = row.filter((other) => other !== id);
  // A row of one is the whole grid; there is no boundary to move.
  if (!others.length) {
    layout.spans[id] = GRID_COLUMNS;
    return;
  }
  if (span >= GRID_COLUMNS) {
    layout.rows[at.row] = [id];
    layout.rows.splice(at.row + 1, 0, others);
    layout.spans[id] = GRID_COLUMNS;
    fitRow(others, layout.spans);
    return;
  }
  layout.spans[id] = Math.min(span, GRID_COLUMNS - MIN_SPAN * others.length);

  // Nearest first, and to the right first: the grip is on the panel's right
  // corner, so the boundary the cursor is pushing is the one that should move.
  const queue = [...others.slice(at.index), ...others.slice(0, at.index).reverse()];
  const sum = () => row.reduce((total, other) => total + (layout.spans[other] ?? 0), 0);
  for (let guard = 0; sum() > GRID_COLUMNS && guard < GRID_COLUMNS * row.length; guard += 1) {
    const donor = queue.find((other) => (layout.spans[other] ?? 0) > MIN_SPAN);
    if (!donor) break;
    layout.spans[donor] = (layout.spans[donor] ?? MIN_SPAN) - 1;
  }
  for (let guard = 0; sum() < GRID_COLUMNS && guard < GRID_COLUMNS * row.length; guard += 1) {
    const taker = queue[0] as string;
    layout.spans[taker] = (layout.spans[taker] ?? MIN_SPAN) + 1;
  }
  fitRow(row, layout.spans);
}

/*
 * The frame's promise used to be a width, `previewSpan`, resolved here. It is
 * `previewResize` in `home-pack.ts` now and returns a whole rectangle: once a
 * panel could grow leftwards — taking columns from the neighbour on its left, or
 * asking for the grid and moving to the first column — a width no longer said
 * where the panel would be. Same bargain, one more coordinate, and only one
 * function answering the question.
 */
