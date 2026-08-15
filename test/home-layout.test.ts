// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import {
  addWidget,
  clampSpan,
  defaultHomeLayout,
  MIN_SPAN,
  hiddenWidgets,
  moveWidget,
  removeWidget,
  resolveHomeLayout,
  setWidgetSpan,
} from "../src/web/client/src/features/home/home-layout";
import { WIDGETS } from "../src/web/client/src/features/home/widget-registry";
import { parseUiPreferences } from "../src/web/client/src/features/settings/ui-preferences";
import type { WidgetDefinition } from "../src/web/client/src/features/home/widget-types";

/**
 * Home's saved layout — stage 2 of the dashboard design.
 *
 * The layout is `localStorage` data resolved against a code-owned registry, so
 * every test here is really about one question: what happens when the two
 * disagree. A stored id the registry dropped, a width that is not a grid
 * column, a user who removed everything.
 */

function widget(id: string, span: 4 | 6 | 12): WidgetDefinition {
  return {
    id,
    titleKey: "home.widget.services",
    icon: null,
    span,
    scope: "global",
    source: "dashboard",
    page: "home",
    render: () => null,
  };
}

const REGISTRY = [widget("a", 4), widget("b", 6), widget("c", 12)];

describe("resolving a saved layout", () => {
  test("no saved layout follows the registry, order and declared widths", () => {
    expect(resolveHomeLayout(REGISTRY, null).map(({ span, widget: w }) => [w.id, span])).toEqual([
      ["a", 4],
      ["b", 6],
      ["c", 12],
    ]);
  });

  test("a saved layout wins on order, membership and width", () => {
    const placed = resolveHomeLayout(REGISTRY, { widgets: ["c", "a"], spans: { a: 12 } });
    expect(placed.map(({ span, widget: w }) => [w.id, span])).toEqual([
      ["c", 12],
      ["a", 12],
    ]);
  });

  test("an id the registry no longer knows is dropped, not rendered as an error", () => {
    // §8.5: a widget removed in a later release must not brick a saved Home.
    const placed = resolveHomeLayout(REGISTRY, { widgets: ["a", "gone", "b"], spans: {} });
    expect(placed.map(({ widget: w }) => w.id)).toEqual(["a", "b"]);
  });

  test("a width outside the grid falls back to the widget's own", () => {
    for (const span of [0, 2, 13, 6.5]) {
      expect(resolveHomeLayout(REGISTRY, { widgets: ["b"], spans: { b: span } })[0]?.span).toBe(6);
    }
    // Any column count between the minimum and the grid is a width a drag can
    // land on, so 7 is as legitimate as the 4/6/12 the registry declares.
    expect(resolveHomeLayout(REGISTRY, { widgets: ["b"], spans: { b: 7 } })[0]?.span).toBe(7);
  });

  test("a drag is clamped to the grid rather than snapped to presets", () => {
    expect(clampSpan(7.4)).toBe(7);
    expect(clampSpan(0.2)).toBe(MIN_SPAN);
    expect(clampSpan(99)).toBe(12);
    expect(clampSpan(Number.NaN)).toBe(MIN_SPAN);
  });

  test("the real registry has unique ids, since a duplicate would share a React key", () => {
    expect(new Set(WIDGETS.map((w) => w.id)).size).toBe(WIDGETS.length);
  });
});

describe("editing a layout", () => {
  test("the first edit materialises the default rather than storing a fragment", () => {
    const next = removeWidget(REGISTRY, null, "b");
    expect(next.widgets).toEqual(["a", "c"]);
    // Widths come along, so a later registry change cannot silently resize a
    // layout the user has already arranged.
    expect(next.spans).toMatchObject({ a: 4, b: 6, c: 12 });
  });

  test("removing everything is a state, not a reset", () => {
    let layout = defaultHomeLayout(REGISTRY);
    for (const w of REGISTRY) layout = removeWidget(REGISTRY, layout, w.id);
    expect(layout.widgets).toEqual([]);
    expect(resolveHomeLayout(REGISTRY, layout)).toEqual([]);
  });

  test("a removed widget comes back at the end, at the width it had", () => {
    const removed = setWidgetSpan(REGISTRY, removeWidget(REGISTRY, null, "a"), "a", 12);
    const added = addWidget(REGISTRY, removed, "a");
    expect(added.widgets).toEqual(["b", "c", "a"]);
    expect(resolveHomeLayout(REGISTRY, added).at(-1)?.span).toBe(12);
  });

  test("adding a widget twice is a no-op", () => {
    const once = addWidget(REGISTRY, { widgets: ["a"], spans: {} }, "b");
    expect(addWidget(REGISTRY, once, "b").widgets).toEqual(["a", "b"]);
  });

  test("moving swaps with the neighbour and stops at both ends", () => {
    const layout = defaultHomeLayout(REGISTRY);
    expect(moveWidget(REGISTRY, layout, "c", -1).widgets).toEqual(["a", "c", "b"]);
    expect(moveWidget(REGISTRY, layout, "a", -1).widgets).toEqual(["a", "b", "c"]);
    expect(moveWidget(REGISTRY, layout, "c", 1).widgets).toEqual(["a", "b", "c"]);
  });

  test("hidden widgets are what a picker offers, and nothing is hidden by default", () => {
    expect(hiddenWidgets(REGISTRY, null)).toEqual([]);
    expect(hiddenWidgets(REGISTRY, { widgets: ["b"], spans: {} }).map((w) => w.id)).toEqual([
      "a",
      "c",
    ]);
  });
});

describe("the stored shape", () => {
  const base = {
    version: 2,
    theme: "system",
    language: "en",
    density: "comfortable",
    codeFontSize: 12,
    reducedMotion: false,
    sidebarDocked: false,
    projectScope: "all",
  };

  test("a v2 install migrates to v3 with no layout, so it keeps following the registry", () => {
    const parsed = parseUiPreferences(base);
    expect(parsed?.version).toBe(3);
    expect(parsed?.home).toBeNull();
  });

  test("a malformed layout reads as never-customised rather than as no widgets", () => {
    expect(parseUiPreferences({ ...base, home: { widgets: "services" } })?.home).toBeNull();
    expect(parseUiPreferences({ ...base, home: [] })?.home).toBeNull();
  });

  test("duplicate ids and impossible widths are dropped on read", () => {
    const parsed = parseUiPreferences({
      ...base,
      home: { widgets: ["a", "a", 7, "", "b"], spans: { a: 6, b: 40, gone: 4 } },
    });
    expect(parsed?.home).toEqual({ widgets: ["a", "b"], spans: { a: 6 } });
  });

  test("an empty list survives a round trip, because it is a choice", () => {
    expect(parseUiPreferences({ ...base, home: { widgets: [], spans: {} } })?.home).toEqual({
      widgets: [],
      spans: {},
    });
  });
});
