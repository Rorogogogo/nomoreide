// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import {
  addWidget,
  clampH,
  clampW,
  clampX,
  defaultHomeLayout,
  GRID_COLUMNS,
  hiddenWidgets,
  MAX_HEIGHT,
  MIN_HEIGHT,
  MIN_SPAN,
  moveWidget,
  nudgeWidget,
  removeWidget,
  resolveHomeLayout,
  setWidgetSize,
} from "../apps/dashboard/src/features/home/home-layout";
import { WIDGETS } from "../apps/dashboard/src/features/home/widget-registry";
import type { WidgetDefinition } from "../apps/dashboard/src/features/home/widget-types";
import type { HomeLayout } from "../apps/dashboard/src/features/settings/ui-preferences";
import { parseUiPreferences } from "../apps/dashboard/src/features/settings/ui-preferences";

/**
 * Home's saved layout, now that a panel is a rectangle.
 *
 * The layout is `localStorage` data resolved against a code-owned registry, so
 * most of these are one question asked from different angles: what happens when
 * the two disagree — a stored id the registry dropped, a coordinate off the
 * grid, a user who removed everything.
 *
 * What is *not* asked here any more is whether a row fills the grid. There are
 * no rows to fill: the invariant moved to `home-grid.test.ts`, where it is the
 * stronger one a rectangle allows — panels never overlap, and nothing is left
 * standing above a gap something below it could rise into.
 */

function widget(id: string, span: number): WidgetDefinition {
  return {
    id,
    titleKey: "home.widget.services",
    icon: null,
    span: span as WidgetDefinition["span"],
    scope: "global",
    source: "dashboard",
    page: "home",
    render: () => null,
  };
}

const REGISTRY = [widget("a", 4), widget("b", 4), widget("c", 4)];

/** Ids in reading order — the order the page is read and the keyboard walks. */
function order(layout: HomeLayout | null, widgets = REGISTRY): string[] {
  return resolveHomeLayout(widgets, layout).map((entry) => entry.widget.id);
}

function tiles(layout: HomeLayout): Record<string, [number, number, number, number | null]> {
  const out: Record<string, [number, number, number, number | null]> = {};
  for (const [id, tile] of Object.entries(layout.tiles)) out[id] = [tile.x, tile.y, tile.w, tile.h];
  return out;
}

describe("resolving a saved layout", () => {
  test("no saved layout flows the registry's own order and widths", () => {
    expect(tiles(defaultHomeLayout(REGISTRY))).toEqual({
      a: [0, 0, 4, null],
      b: [4, 0, 4, null],
      c: [8, 0, 4, null],
    });
  });

  test("wraps to a new band when the one being filled runs out", () => {
    const wide = [widget("a", 8), widget("b", 8)];
    expect(tiles(defaultHomeLayout(wide)).b[1]).toBe(MIN_HEIGHT);
  });

  test("no widget is given a height — that is a fact about what it holds", () => {
    for (const tile of Object.values(defaultHomeLayout(WIDGETS).tiles)) {
      expect(tile.h).toBeNull();
    }
  });

  test("a saved layout wins on position and width", () => {
    const saved: HomeLayout = {
      tiles: { b: { x: 0, y: 0, w: 6, h: null }, a: { x: 6, y: 0, w: 6, h: 4 } },
    };
    expect(order(saved)).toEqual(["b", "a"]);
    expect(resolveHomeLayout(REGISTRY, saved)[1]?.tile).toEqual({ x: 6, y: 0, w: 6, h: 4 });
  });

  test("an id the registry no longer knows is dropped rather than rendered", () => {
    const saved: HomeLayout = {
      tiles: { gone: { x: 0, y: 0, w: 6, h: null }, a: { x: 6, y: 0, w: 6, h: null } },
    };
    expect(order(saved)).toEqual(["a"]);
  });

  test("reads down the page and then across", () => {
    const saved: HomeLayout = {
      tiles: {
        c: { x: 0, y: 4, w: 6, h: null },
        b: { x: 6, y: 0, w: 6, h: null },
        a: { x: 0, y: 0, w: 6, h: null },
      },
    };
    expect(order(saved)).toEqual(["a", "b", "c"]);
  });

  test("a drag is clamped to the grid rather than snapped to presets", () => {
    expect(clampW(7, GRID_COLUMNS)).toBe(7);
    expect(clampW(99, GRID_COLUMNS)).toBe(GRID_COLUMNS);
    expect(clampW(0, GRID_COLUMNS)).toBe(MIN_SPAN);
    expect(clampH(99)).toBe(MAX_HEIGHT);
    expect(clampH(0)).toBe(MIN_HEIGHT);
    // A panel may not hang off the right edge, however far the drag went.
    expect(clampX(11, 6, GRID_COLUMNS)).toBe(6);
  });
});

describe("resizing", () => {
  test("does not take columns from anybody", () => {
    // The old model had to: a row summed to the grid, so a panel could only
    // grow by making its neighbour shrink. Rectangles do not share a row, so a
    // width is now nobody else's business — the packer moves whoever is in the
    // way, and moves them back when the panel shrinks again.
    const next = setWidgetSize(REGISTRY, null, "a", { w: 8 });
    expect(tiles(next).a).toEqual([0, 0, 8, null]);
    expect(tiles(next).b).toEqual([4, 0, 4, null]);
  });

  test("keeps a widened panel on the page", () => {
    const saved: HomeLayout = { tiles: { a: { x: 8, y: 0, w: 4, h: null } } };
    expect(tiles(setWidgetSize(REGISTRY, saved, "a", { w: 8 })).a).toEqual([4, 0, 8, null]);
  });

  test("stores a height in rows, and clears it back to fitting the content", () => {
    const tall = setWidgetSize(REGISTRY, null, "a", { h: 9 });
    expect(tiles(tall).a[3]).toBe(9);
    expect(tiles(setWidgetSize(REGISTRY, tall, "a", { h: null })).a[3]).toBeNull();
  });

  test("leaves the axis it does not touch alone", () => {
    const both = setWidgetSize(REGISTRY, null, "a", { w: 6, h: 5 });
    expect(tiles(setWidgetSize(REGISTRY, both, "a", { h: 7 })).a).toEqual([0, 0, 6, 7]);
  });
});

describe("editing a layout", () => {
  test("a new widget arrives at the foot of the page, full width", () => {
    const without = removeWidget(REGISTRY, null, "c");
    expect(order(without)).toEqual(["a", "b"]);
    const back = addWidget(REGISTRY, without, "c");
    expect(tiles(back).c[0]).toBe(0);
    expect(tiles(back).c[2]).toBe(GRID_COLUMNS);
    expect(order(back).at(-1)).toBe("c");
  });

  test("adding something already on the page changes nothing", () => {
    const layout = defaultHomeLayout(REGISTRY);
    expect(tiles(addWidget(REGISTRY, layout, "a"))).toEqual(tiles(layout));
  });

  test("the picker offers exactly what is not on the page", () => {
    const without = removeWidget(REGISTRY, null, "b");
    expect(hiddenWidgets(REGISTRY, without).map((w) => w.id)).toEqual(["b"]);
    expect(hiddenWidgets(REGISTRY, null)).toEqual([]);
  });

  test("removing the last widget leaves a layout, not a null", () => {
    let layout: HomeLayout | null = null;
    for (const id of ["a", "b", "c"]) layout = removeWidget(REGISTRY, layout, id);
    expect(order(layout)).toEqual([]);
    // `null` would mean "never customised" and bring the defaults straight back.
    expect(layout).not.toBeNull();
  });
});

describe("dropping a panel somewhere else", () => {
  test("writes the coordinates it was dropped at", () => {
    const next = moveWidget(REGISTRY, null, "a", { x: 6, y: 5 });
    expect(tiles(next).a).toEqual([6, 5, 4, null]);
  });

  test("a drop past the edges is pulled back onto the grid", () => {
    expect(tiles(moveWidget(REGISTRY, null, "a", { x: 99, y: -4 })).a).toEqual([8, 0, 4, null]);
  });

  test("moves the panel in reading order, which is what a drop is for", () => {
    // Every cell is a legal drop now, including the empty ones — there is no
    // such thing as a drop the layout refuses, so this is the whole contract.
    expect(order(moveWidget(REGISTRY, null, "c", { x: 0, y: 0 }))).toEqual(["c", "a", "b"]);
  });
});

describe("the keyboard's version of a drag", () => {
  test("swaps a panel with its neighbour in reading order", () => {
    expect(order(nudgeWidget(REGISTRY, null, "a", 1))).toEqual(["b", "a", "c"]);
    expect(order(nudgeWidget(REGISTRY, null, "c", -1))).toEqual(["a", "c", "b"]);
  });

  test("does nothing at the ends, rather than wrapping around", () => {
    expect(order(nudgeWidget(REGISTRY, null, "a", -1))).toEqual(["a", "b", "c"]);
    expect(order(nudgeWidget(REGISTRY, null, "c", 1))).toEqual(["a", "b", "c"]);
  });
});

describe("the stored shape", () => {
  test("survives a round trip through the preferences parser", () => {
    const layout = setWidgetSize(REGISTRY, null, "a", { w: 8, h: 5 });
    const parsed = parseUiPreferences({
      ...JSON.parse(JSON.stringify({ ...base(), home: layout })),
    });
    expect(parsed?.home?.tiles.a).toEqual({ x: 0, y: 0, w: 8, h: 5 });
  });

  test("migrates a v4 layout of named rows into rectangles", () => {
    const parsed = parseUiPreferences({
      ...base(),
      version: 4,
      home: { rows: [["a", "b"], ["c"]], spans: { a: 4, b: 8, c: 12 }, heights: { a: 5 } },
    });
    // The page it drew: two panels on the first line at their stored widths,
    // the third below them — and the height the user had chosen kept.
    expect(parsed?.home?.tiles).toEqual({
      a: { x: 0, y: 0, w: 4, h: 5 },
      b: { x: 4, y: 0, w: 8, h: null },
      c: { x: 0, y: 5, w: 12, h: null },
    });
  });

  test("migrates a v3 flat list the same way", () => {
    const parsed = parseUiPreferences({
      ...base(),
      version: 3,
      home: { widgets: ["a", "b"], spans: { a: 6, b: 6 } },
    });
    expect(parsed?.home?.tiles.b).toEqual({ x: 6, y: 0, w: 6, h: null });
  });

  test("drops a rectangle that is not one", () => {
    const parsed = parseUiPreferences({
      ...base(),
      home: { tiles: { a: { x: "nope", y: 2, w: 6, h: null }, b: null } },
    });
    expect(parsed?.home?.tiles.a).toEqual({ x: 0, y: 2, w: 6, h: null });
    expect(parsed?.home?.tiles.b).toBeUndefined();
  });
});

function base() {
  return {
    version: 5,
    theme: "system",
    language: "en",
    density: "comfortable",
    codeFontSize: 13,
    reducedMotion: false,
    sidebarDocked: true,
    projectScope: "project",
  };
}
