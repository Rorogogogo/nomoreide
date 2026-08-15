// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import {
  addWidget,
  canDropAt,
  clampHeight,
  clampSpan,
  defaultHomeLayout,
  GRID_COLUMNS,
  MAX_HEIGHT,
  MAX_ROW_WIDGETS,
  MIN_HEIGHT,
  MIN_SPAN,
  hiddenWidgets,
  moveWidget,
  nudgeWidget,
  previewSpan,
  removeWidget,
  resolveHomeLayout,
  setWidgetSize,
} from "../src/web/client/src/features/home/home-layout";
import { WIDGETS } from "../src/web/client/src/features/home/widget-registry";
import { parseUiPreferences } from "../src/web/client/src/features/settings/ui-preferences";
import type { HomeLayout } from "../src/web/client/src/features/settings/ui-preferences";
import type { WidgetDefinition } from "../src/web/client/src/features/home/widget-types";

/**
 * Home's saved layout.
 *
 * The layout is `localStorage` data resolved against a code-owned registry, so
 * most of these are really one question: what happens when the two disagree —
 * a stored id the registry dropped, a width that is not a grid column, a user
 * who removed everything.
 *
 * The rest are about the invariant the rows exist for: **a row always fills the
 * grid.** Anything that can change a row — a resize, a removal, a drop, a
 * widget the registry no longer ships — has to leave it summing to twelve,
 * because the alternative is the dead space at the end of a row that made rows
 * necessary in the first place.
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

/** Every row, as `[id, span]` pairs — the shape most assertions here want. */
function shape(layout: HomeLayout | null, registry = REGISTRY) {
  return resolveHomeLayout(registry, layout).map((row) =>
    row.widgets.map(({ span, widget: w }) => [w.id, span]),
  );
}

function sums(layout: HomeLayout | null, registry = REGISTRY): number[] {
  return resolveHomeLayout(registry, layout).map((row) =>
    row.widgets.reduce((total, { span }) => total + span, 0),
  );
}

describe("resolving a saved layout", () => {
  test("no saved layout packs the registry's own order and widths into rows", () => {
    // 4 + 6 fits; 12 does not, so it starts a row and fills it.
    expect(shape(null)).toEqual([
      [
        ["a", 6],
        ["b", 6],
      ],
      [["c", 12]],
    ]);
  });

  test("a row that does not fill the grid is widened until it does", () => {
    // The stored widths add up to 8 of 12. Nobody asked for four empty columns
    // at the end of the row, so the columns go to the panels that are there.
    expect(shape({ rows: [["a", "b"]], spans: { a: 4, b: 4 } })).toEqual([
      [
        ["a", 6],
        ["b", 6],
      ],
    ]);
    expect(shape({ rows: [["b"]], spans: { b: 6 } })).toEqual([[["b", 12]]]);
  });

  test("a row that overflows the grid is narrowed from its widest panel", () => {
    expect(shape({ rows: [["a", "b", "c"]], spans: { a: 4, b: 6, c: 12 } })).toEqual([
      [
        ["a", 4],
        ["b", 4],
        ["c", 4],
      ],
    ]);
  });

  test("a saved layout wins on rows, order and width", () => {
    expect(shape({ rows: [["c"], ["b", "a"]], spans: { c: 12, b: 8, a: 4 } })).toEqual([
      [["c", 12]],
      [
        ["b", 8],
        ["a", 4],
      ],
    ]);
  });

  test("an id the registry no longer knows is dropped, and its columns stay in the row", () => {
    // §8.5: a widget removed in a later release must not brick a saved Home —
    // and must not leave a hole where it used to be either.
    expect(shape({ rows: [["a", "gone", "b"]], spans: { a: 4, gone: 4, b: 4 } })).toEqual([
      [
        ["a", 6],
        ["b", 6],
      ],
    ]);
  });

  test("a row of more panels than the grid can hold legibly spills into another", () => {
    const registry = [...REGISTRY, widget("d", 4), widget("e", 4)];
    const rows = shape({ rows: [["a", "b", "c", "d", "e"]], spans: {} }, registry);
    expect(rows[0]).toHaveLength(MAX_ROW_WIDGETS);
    expect(rows[1]?.map(([id]) => id)).toEqual(["e"]);
    expect(sums({ rows: [["a", "b", "c", "d", "e"]], spans: {} }, registry)).toEqual([12, 12]);
  });

  test("a width outside the grid falls back to something the row can use", () => {
    for (const span of [0, 2, 13, 6.5]) {
      expect(shape({ rows: [["b", "a"]], spans: { b: span, a: 6 } })[0]?.[0]?.[1]).toBe(6);
    }
  });

  test("a drag is clamped to the grid rather than snapped to presets", () => {
    expect(clampSpan(7.4)).toBe(7);
    expect(clampSpan(0.2)).toBe(MIN_SPAN);
    expect(clampSpan(99)).toBe(GRID_COLUMNS);
    expect(clampSpan(Number.NaN)).toBe(MIN_SPAN);
  });

  test("a widget nobody has resized vertically fits its content", () => {
    expect(resolveHomeLayout(REGISTRY, null)[0]?.widgets.map(({ height }) => height)).toEqual([
      null,
      null,
    ]);
    expect(
      resolveHomeLayout(REGISTRY, { rows: [["a"]], spans: {} })[0]?.widgets[0]?.height,
    ).toBeNull();
  });

  test("a height outside the ruler falls back to fitting the content", () => {
    for (const height of [0, 1, 13, 4.5]) {
      expect(
        resolveHomeLayout(REGISTRY, { rows: [["b"]], spans: {}, heights: { b: height } })[0]
          ?.widgets[0]?.height,
      ).toBeNull();
    }
    expect(
      resolveHomeLayout(REGISTRY, { rows: [["b"]], spans: {}, heights: { b: 5 } })[0]?.widgets[0]
        ?.height,
    ).toBe(5);
  });

  test("a vertical drag is clamped the same way a horizontal one is", () => {
    expect(clampHeight(4.4)).toBe(4);
    expect(clampHeight(0.1)).toBe(MIN_HEIGHT);
    expect(clampHeight(99)).toBe(MAX_HEIGHT);
    expect(clampHeight(Number.NaN)).toBe(MIN_HEIGHT);
  });

  test("the real registry packs into rows that all fill the grid", () => {
    expect(new Set(WIDGETS.map((w) => w.id)).size).toBe(WIDGETS.length);
    for (const total of sums(null, WIDGETS)) expect(total).toBe(GRID_COLUMNS);
  });
});

describe("resizing", () => {
  test("columns come out of the neighbour, so the row still fills", () => {
    const layout = setWidgetSize(REGISTRY, null, "a", { span: 8 });
    expect(shape(layout)[0]).toEqual([
      ["a", 8],
      ["b", 4],
    ]);
  });

  test("a neighbour is never squeezed below the narrowest legible panel", () => {
    const layout = setWidgetSize(REGISTRY, null, "a", { span: 12 });
    expect(shape(layout)[0]).toEqual([
      ["a", 9],
      ["b", 3],
    ]);
    // And the frame says so before the drop, rather than promising 12.
    expect(previewSpan(REGISTRY, null, "a", 12)).toBe(9);
  });

  test("a panel alone in its row is the whole row, whatever it is dragged to", () => {
    const alone = { rows: [["b"]], spans: { b: 12 } };
    expect(previewSpan(REGISTRY, alone, "b", 5)).toBe(GRID_COLUMNS);
  });

  test("a corner drag stores both axes in one write", () => {
    const next = setWidgetSize(REGISTRY, null, "a", { span: 8, height: 5 });
    expect(next.spans.a).toBe(8);
    expect(next.heights?.a).toBe(5);
    expect(resolveHomeLayout(REGISTRY, next)[0]?.widgets[0]).toMatchObject({ span: 8, height: 5 });
  });

  test("an edge drag leaves the axis it does not touch alone", () => {
    const both = setWidgetSize(REGISTRY, null, "a", { span: 8, height: 5 });
    expect(setWidgetSize(REGISTRY, both, "a", { span: 6 }).heights?.a).toBe(5);
    expect(setWidgetSize(REGISTRY, both, "a", { height: 9 }).spans.a).toBe(8);
  });

  test("a null height is the escape hatch, not a zero", () => {
    const sized = setWidgetSize(REGISTRY, null, "b", { height: 5 });
    const cleared = setWidgetSize(REGISTRY, sized, "b", { height: null });
    expect(cleared.heights).not.toHaveProperty("b");
    expect(resolveHomeLayout(REGISTRY, cleared)[0]?.widgets[1]?.height).toBeNull();
  });

  test("a height out of range is clamped on the way in, never stored raw", () => {
    expect(setWidgetSize(REGISTRY, null, "b", { height: 99 }).heights?.b).toBe(MAX_HEIGHT);
  });
});

describe("editing a layout", () => {
  test("the first edit materialises the default rather than storing a fragment", () => {
    const next = removeWidget(REGISTRY, null, "b");
    expect(next.rows).toEqual([["a"], ["c"]]);
    // And what is left of the row takes the columns the removal freed.
    expect(shape(next)).toEqual([[["a", 12]], [["c", 12]]]);
  });

  test("removing the last widget in a row removes the row", () => {
    const layout = removeWidget(REGISTRY, removeWidget(REGISTRY, null, "a"), "b");
    expect(layout.rows).toEqual([["c"]]);
  });

  test("removing everything is a state, not a reset", () => {
    let layout = defaultHomeLayout(REGISTRY);
    for (const w of REGISTRY) layout = removeWidget(REGISTRY, layout, w.id);
    expect(layout.rows).toEqual([]);
    expect(resolveHomeLayout(REGISTRY, layout)).toEqual([]);
  });

  test("a widget added from the picker arrives as a row of its own", () => {
    const added = addWidget(REGISTRY, removeWidget(REGISTRY, null, "a"), "a");
    expect(added.rows).toEqual([["b"], ["c"], ["a"]]);
    expect(shape(added).at(-1)).toEqual([["a", 12]]);
  });

  test("adding a widget twice is a no-op", () => {
    const once = addWidget(REGISTRY, { rows: [["a"]], spans: {} }, "b");
    expect(addWidget(REGISTRY, once, "b").rows).toEqual([["a"], ["b"]]);
  });

  test("hidden widgets are what a picker offers, and nothing is hidden by default", () => {
    expect(hiddenWidgets(REGISTRY, null)).toEqual([]);
    expect(hiddenWidgets(REGISTRY, { rows: [["b"]], spans: {} }).map((w) => w.id)).toEqual([
      "a",
      "c",
    ]);
  });
});

describe("dropping a panel somewhere else", () => {
  const three = { rows: [["a", "b"], ["c"]], spans: { a: 6, b: 6, c: 12 } };

  test("a drop into another row shares that row out again", () => {
    const next = moveWidget(REGISTRY, three, "c", { row: 0, index: 1, newRow: false });
    expect(next.rows).toEqual([["a", "c", "b"]]);
    expect(sums(next)).toEqual([12]);
  });

  test("a drop between rows makes a row of its own, full width", () => {
    const next = moveWidget(REGISTRY, three, "b", { row: 0, index: 0, newRow: true });
    expect(next.rows).toEqual([["b"], ["a"], ["c"]]);
    expect(shape(next)).toEqual([[["b", 12]], [["a", 12]], [["c", 12]]]);
  });

  test("a drop past the end of its own row moves it to the end, not one short", () => {
    const next = moveWidget(REGISTRY, three, "a", { row: 0, index: 2, newRow: false });
    expect(next.rows).toEqual([["b", "a"], ["c"]]);
  });

  test("giving a widget the row it already has to itself changes nothing", () => {
    const next = moveWidget(REGISTRY, three, "c", { row: 1, index: 0, newRow: true });
    expect(next.rows).toEqual(three.rows);
  });

  test("a row cannot be crowded past what the grid can draw legibly", () => {
    const registry = [...REGISTRY, widget("d", 4), widget("e", 4)];
    const full: HomeLayout = { rows: [["a", "b", "c", "d"], ["e"]], spans: {} };
    const target = { row: 0, index: 0, newRow: false };
    expect(canDropAt(registry, full, "e", target)).toBe(false);
    expect(moveWidget(registry, full, "e", target).rows).toEqual(full.rows);
    // Reordering *within* the full row is still fine — it adds nobody.
    expect(canDropAt(registry, full, "d", target)).toBe(true);
  });

  test("the keyboard walks the page in reading order, across rows and no further", () => {
    expect(nudgeWidget(REGISTRY, three, "a", 1).rows).toEqual([["b", "a"], ["c"]]);
    // Off the end of its row and into the next one.
    expect(nudgeWidget(REGISTRY, three, "b", 1).rows).toEqual([["a"], ["b", "c"]]);
    // The first panel of the first row has nowhere earlier to go.
    expect(nudgeWidget(REGISTRY, three, "a", -1).rows).toEqual(three.rows);
    expect(nudgeWidget(REGISTRY, three, "c", -1).rows).toEqual([["a", "b", "c"]]);
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

  test("a v2 install migrates with no layout, so it keeps following the registry", () => {
    const parsed = parseUiPreferences(base);
    expect(parsed?.version).toBe(4);
    expect(parsed?.home).toBeNull();
  });

  test("a v3 layout is packed into the rows its widths were already drawing", () => {
    const parsed = parseUiPreferences({
      ...base,
      home: { widgets: ["a", "b", "c"], spans: { a: 4, b: 6, c: 12 } },
    });
    expect(parsed?.home?.rows).toEqual([["a", "b"], ["c"]]);
    expect(parsed?.home?.spans).toEqual({ a: 4, b: 6, c: 12 });
  });

  test("a malformed layout reads as never-customised rather than as no widgets", () => {
    expect(parseUiPreferences({ ...base, home: { rows: "services" } })?.home).toBeNull();
    expect(parseUiPreferences({ ...base, home: [] })?.home).toBeNull();
  });

  test("duplicate ids and impossible sizes are dropped on read", () => {
    const parsed = parseUiPreferences({
      ...base,
      home: {
        rows: [["a", "a", 7, ""], ["b"], []],
        spans: { a: 6, b: 40, gone: 4 },
        heights: { a: 5, b: 99, gone: 3 },
      },
    });
    expect(parsed?.home).toEqual({ rows: [["a"], ["b"]], spans: { a: 6 }, heights: { a: 5 } });
  });

  test("a layout stored before heights existed reads as heights nobody has set", () => {
    const parsed = parseUiPreferences({ ...base, home: { rows: [["a"]], spans: { a: 6 } } });
    expect(parsed?.home).toEqual({ rows: [["a"]], spans: { a: 6 }, heights: {} });
  });

  test("an empty layout survives a round trip, because it is a choice", () => {
    expect(parseUiPreferences({ ...base, home: { rows: [], spans: {} } })?.home).toEqual({
      rows: [],
      spans: {},
      heights: {},
    });
  });
});
