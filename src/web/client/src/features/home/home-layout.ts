import type { HomeLayout } from "@/features/settings/ui-preferences";
import type { WidgetDefinition, WidgetSpan } from "./widget-types";

/**
 * Stage 2 of `docs/plans/2026-08-15-home-dashboard-design.md`: what the user
 * keeps, in what order, at what width.
 *
 * Everything here is a pure function of `(registry, storedLayout)`, which is
 * what lets the whole feature be tested without mounting React and keeps Home
 * itself free of layout arithmetic. The stored layout is data from
 * `localStorage` and is treated as such — it never decides *what a widget is*,
 * only which of the registry's widgets are shown and how wide.
 */

/** The grid a width is measured in, and the narrowest panel worth having. */
export const GRID_COLUMNS = 12;
export const MIN_SPAN = 3;

/**
 * The vertical ruler.
 *
 * Columns are a fraction of the window and so need no unit; rows cannot be —
 * there is no page height to divide, because Home scrolls. So a height is a
 * count of fixed 32px units, which is what makes two panels dragged to "4"
 * actually line up. Four units is roughly what a stat strip over three rows
 * comes to, which is the shape most widgets have.
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

function isSpan(value: unknown): value is WidgetSpan {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_SPAN &&
    value <= GRID_COLUMNS
  );
}

function isHeight(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_HEIGHT &&
    value <= MAX_HEIGHT
  );
}

/** Any column count a drag can produce, pulled back into the legal range. */
export function clampSpan(columns: number): WidgetSpan {
  return clamp(columns, MIN_SPAN, GRID_COLUMNS) as WidgetSpan;
}

/** The same, vertically. */
export function clampHeight(rows: number): number {
  return clamp(rows, MIN_HEIGHT, MAX_HEIGHT);
}

function clamp(value: number, min: number, max: number): number {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded)) return min;
  return Math.min(max, Math.max(min, rounded));
}

/**
 * The registry's own order and declared widths — the "example" layout every
 * install starts from, and what Reset returns to.
 *
 * It is derived rather than stored, so a widget added in a later release shows
 * up for everyone who has never customised Home instead of requiring a
 * migration to inject an id into their saved list.
 */
export function defaultHomeLayout(widgets: WidgetDefinition[]): HomeLayout {
  return {
    widgets: widgets.map((widget) => widget.id),
    spans: Object.fromEntries(widgets.map((widget) => [widget.id, widget.span])),
    // No heights: a widget declares a width because a width is a layout
    // decision, but how tall it is is a fact about what it currently holds.
    heights: {},
  };
}

/**
 * What Home actually draws.
 *
 * A `null` layout means "never customised" and follows the registry. A stored
 * one names ids, and an id the registry no longer knows is **dropped
 * silently** (§8.5) — a widget removed in a later release must not turn a saved
 * layout into an error message on the landing page.
 */
export function resolveHomeLayout(
  widgets: WidgetDefinition[],
  layout: HomeLayout | null,
): PlacedWidget[] {
  if (!layout) return widgets.map((widget) => ({ widget, span: widget.span, height: null }));
  const byId = new Map(widgets.map((widget) => [widget.id, widget]));
  const placed: PlacedWidget[] = [];
  for (const id of layout.widgets) {
    const widget = byId.get(id);
    if (!widget) continue;
    const span = layout.spans[id];
    const height = layout.heights?.[id];
    placed.push({
      widget,
      span: isSpan(span) ? span : widget.span,
      height: isHeight(height) ? height : null,
    });
  }
  return placed;
}

/** The widgets a picker can offer: registered, and not currently placed. */
export function hiddenWidgets(
  widgets: WidgetDefinition[],
  layout: HomeLayout | null,
): WidgetDefinition[] {
  if (!layout) return [];
  const shown = new Set(resolveHomeLayout(widgets, layout).map(({ widget }) => widget.id));
  return widgets.filter((widget) => !shown.has(widget.id));
}

/**
 * Every edit starts by materialising the default.
 *
 * The first change a user makes — removing one widget, widening another — is
 * also the moment their layout stops tracking the registry. Writing the full
 * list at that point is what makes the rest of the operations plain array
 * arithmetic, and what makes "I removed everything" storable at all.
 */
function materialize(widgets: WidgetDefinition[], layout: HomeLayout | null): HomeLayout {
  return layout
    ? { widgets: [...layout.widgets], spans: { ...layout.spans }, heights: { ...layout.heights } }
    : defaultHomeLayout(widgets);
}

export function addWidget(
  widgets: WidgetDefinition[],
  layout: HomeLayout | null,
  id: string,
): HomeLayout {
  const next = materialize(widgets, layout);
  if (next.widgets.includes(id)) return next;
  next.widgets.push(id);
  return next;
}

export function removeWidget(
  widgets: WidgetDefinition[],
  layout: HomeLayout | null,
  id: string,
): HomeLayout {
  const next = materialize(widgets, layout);
  next.widgets = next.widgets.filter((widgetId) => widgetId !== id);
  // The span override outlives the removal on purpose: put the widget back and
  // it returns at the width you had chosen for it, not at its declared one.
  return next;
}

/**
 * Move a widget one place earlier or later.
 *
 * Reordering is a permutation of a list, not free 2D placement (§6) — the grid
 * flows, so "one place earlier" is the only move that means anything, and it
 * needs no drag surface, no pointer capture, and no keyboard-accessibility
 * escape hatch to be usable.
 */
export function moveWidget(
  widgets: WidgetDefinition[],
  layout: HomeLayout | null,
  id: string,
  delta: -1 | 1,
): HomeLayout {
  const next = materialize(widgets, layout);
  const from = next.widgets.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= next.widgets.length) return next;
  next.widgets.splice(to, 0, ...next.widgets.splice(from, 1));
  return next;
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
  if (size.span !== undefined) next.spans = { ...next.spans, [id]: size.span };
  if (size.height !== undefined) {
    const heights = { ...next.heights };
    if (size.height === null) delete heights[id];
    else heights[id] = clampHeight(size.height);
    next.heights = heights;
  }
  return next;
}

export function setWidgetSpan(
  widgets: WidgetDefinition[],
  layout: HomeLayout | null,
  id: string,
  span: WidgetSpan,
): HomeLayout {
  return setWidgetSize(widgets, layout, id, { span });
}
