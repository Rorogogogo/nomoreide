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

/** The widths a user can pick, narrowest first. Mirrors the `WidgetSpan` union. */
export const WIDGET_SPANS: readonly WidgetSpan[] = [4, 6, 12];

export interface PlacedWidget {
  widget: WidgetDefinition;
  span: WidgetSpan;
}

function isSpan(value: unknown): value is WidgetSpan {
  return WIDGET_SPANS.includes(value as WidgetSpan);
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
  if (!layout) return widgets.map((widget) => ({ widget, span: widget.span }));
  const byId = new Map(widgets.map((widget) => [widget.id, widget]));
  const placed: PlacedWidget[] = [];
  for (const id of layout.widgets) {
    const widget = byId.get(id);
    if (!widget) continue;
    const span = layout.spans[id];
    placed.push({ widget, span: isSpan(span) ? span : widget.span });
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
  return layout ? { widgets: [...layout.widgets], spans: { ...layout.spans } } : defaultHomeLayout(widgets);
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

export function setWidgetSpan(
  widgets: WidgetDefinition[],
  layout: HomeLayout | null,
  id: string,
  span: WidgetSpan,
): HomeLayout {
  const next = materialize(widgets, layout);
  next.spans = { ...next.spans, [id]: span };
  return next;
}
