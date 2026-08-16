import { describe, expect, test } from "vitest";
import { HOME_ROW_PX, type PlacedRow, type PlacedWidget } from "../src/web/client/src/features/home/home-layout";
import {
  gridColumns,
  packHome,
  spanFor,
  HOME_MID_WIDTH,
  HOME_WIDE_WIDTH,
} from "../src/web/client/src/features/home/home-pack";
import type { WidgetDefinition, WidgetSpan } from "../src/web/client/src/features/home/widget-types";

/**
 * Where the panels land.
 *
 * The layout model still says what is beside what (`home-layout.test.ts`); this
 * is the other half — how far down each panel starts once a row is no longer
 * allowed to decide that for everyone in it.
 *
 * Almost every test here is one question asked from a different angle: **does a
 * panel rise into the space left by a short one above it?** That is the entire
 * reason this file exists, and it is the one thing a grid of rows could not do.
 */

function panel(id: string, span: WidgetSpan, height: number | null = null): PlacedWidget {
  const widget: WidgetDefinition = {
    id,
    titleKey: "home.widget.services",
    icon: null,
    span,
    scope: "global",
    source: "dashboard",
    page: "home",
    render: () => null,
  };
  return { widget, span, height };
}

function row(...widgets: PlacedWidget[]): PlacedRow {
  return { widgets };
}

/** Placements as `id -> [left, width, top, height]`, which is what most asserts want. */
function boxes(rows: PlacedRow[], measured: Record<string, number>, columns: number) {
  const out: Record<string, [string, string, number, number]> = {};
  for (const place of packHome(rows, measured, columns).placements) {
    out[place.id] = [place.left, place.width, place.top, place.height];
  }
  return out;
}

/** Just the tops, for the tests that are only about the stacking. */
function tops(rows: PlacedRow[], measured: Record<string, number>, columns = 12) {
  const out: Record<string, number> = {};
  for (const place of packHome(rows, measured, columns).placements) out[place.id] = place.top;
  return out;
}

describe("gridColumns", () => {
  test("gives all twelve only from the xl breakpoint up", () => {
    expect(gridColumns(1600)).toBe(12);
    expect(gridColumns(HOME_WIDE_WIDTH)).toBe(12);
    expect(gridColumns(HOME_WIDE_WIDTH - 1)).toBe(2);
  });

  test("collapses to two columns and then to one", () => {
    expect(gridColumns(1000)).toBe(2);
    expect(gridColumns(HOME_MID_WIDTH)).toBe(2);
    expect(gridColumns(HOME_MID_WIDTH - 1)).toBe(1);
    expect(gridColumns(320)).toBe(1);
  });
});

describe("spanFor", () => {
  test("is the stored width when there are twelve columns", () => {
    for (const span of [3, 4, 6, 7, 12]) expect(spanFor(span, 12)).toBe(span);
  });

  test("takes both narrow columns only when wider than half the grid", () => {
    expect(spanFor(6, 2)).toBe(1);
    expect(spanFor(7, 2)).toBe(2);
    expect(spanFor(12, 2)).toBe(2);
  });

  test("is one column when that is all there is", () => {
    expect(spanFor(12, 1)).toBe(1);
    expect(spanFor(3, 1)).toBe(1);
  });
});

describe("packHome", () => {
  test("puts a single row at the top and sizes the grid to it", () => {
    const packed = packHome([row(panel("a", 12))], { a: 90 }, 12);
    expect(packed.placements).toEqual([
      { id: "a", left: "0%", width: "100%", top: 0, height: 90 },
    ]);
    expect(packed.height).toBe(90);
  });

  test("places a row left to right as shares of the grid", () => {
    const rows = [row(panel("a", 3), panel("b", 4), panel("c", 5))];
    expect(boxes(rows, { a: 50, b: 50, c: 50 }, 12)).toEqual({
      a: ["0%", "25%", 0, 50],
      b: ["25%", `${(4 / 12) * 100}%`, 0, 50],
      c: [`${(7 / 12) * 100}%`, `${(5 / 12) * 100}%`, 0, 50],
    });
  });

  test("lets a panel rise into the space a short one above it leaves", () => {
    // The whole point. Row 0 is 200 tall on the left and 100 on the right; row 1
    // must *not* start at 200 on both sides the way a grid row would.
    const rows = [row(panel("a", 6), panel("b", 6)), row(panel("c", 6), panel("d", 6))];
    expect(tops(rows, { a: 200, b: 100, c: 40, d: 40 })).toEqual({
      a: 0,
      b: 0,
      c: 200,
      d: 100,
    });
  });

  test("stacks a column as far as its own contents go, not the page's", () => {
    const rows = [
      row(panel("a", 6), panel("b", 6)),
      row(panel("c", 6), panel("d", 6)),
      row(panel("e", 6), panel("f", 6)),
    ];
    // Left column: 100, 100 → third starts at 200. Right: 30, 30 → 60.
    expect(tops(rows, { a: 100, b: 30, c: 100, d: 30, e: 10, f: 10 })).toEqual({
      a: 0,
      b: 0,
      c: 100,
      d: 30,
      e: 200,
      f: 60,
    });
  });

  test("holds a wide panel up on the lowest column it covers", () => {
    const rows = [row(panel("a", 6), panel("b", 6)), row(panel("c", 12))];
    // `c` spans both, so the taller neighbour decides — it cannot overlap either.
    expect(tops(rows, { a: 100, b: 300, c: 50 })).toEqual({ a: 0, b: 0, c: 300 });
  });

  test("is as tall as its longest column, never the sum of the rows", () => {
    const rows = [row(panel("a", 6), panel("b", 6)), row(panel("c", 6), panel("d", 6))];
    const packed = packHome(rows, { a: 200, b: 100, c: 40, d: 40 }, 12);
    expect(packed.height).toBe(240);
  });

  test("uses a stored height when nothing has been measured yet", () => {
    const rows = [row(panel("a", 12, 4))];
    const packed = packHome(rows, {}, 12);
    expect(packed.height).toBe(4 * HOME_ROW_PX);
    expect(packed.placements[0]?.height).toBe(4 * HOME_ROW_PX);
  });

  test("prefers what a panel measured over what it asked for", () => {
    // The stored number is a request; the skyline has to stack against the box
    // that is actually on screen or the panel below it overlaps.
    const rows = [row(panel("a", 12, 4)), row(panel("b", 12))];
    expect(tops(rows, { a: 130, b: 20 })).toEqual({ a: 0, b: 130 });
  });

  test("treats an unlaid-out panel's zero as no measurement at all", () => {
    const rows = [row(panel("a", 12, 4)), row(panel("b", 12))];
    expect(tops(rows, { a: 0, b: 0 })).toEqual({ a: 0, b: 4 * HOME_ROW_PX });
  });

  test("gives a panel with neither a height nor a measurement none", () => {
    const packed = packHome([row(panel("a", 12))], {}, 12);
    expect(packed.height).toBe(0);
    expect(packed.placements[0]?.top).toBe(0);
  });

  test("has nothing to place, and no height, for an empty layout", () => {
    expect(packHome([], {}, 12)).toEqual({ placements: [], height: 0 });
  });

  describe("below the wide breakpoint", () => {
    test("puts two panels per line and wraps within the row", () => {
      const rows = [row(panel("a", 3), panel("b", 3), panel("c", 3), panel("d", 3))];
      expect(boxes(rows, { a: 10, b: 20, c: 10, d: 10 }, 2)).toEqual({
        a: ["0%", "50%", 0, 10],
        b: ["50%", "50%", 0, 20],
        c: ["0%", "50%", 10, 10],
        d: ["50%", "50%", 20, 10],
      });
    });

    test("starts each stored row on its own line, as its own grid used to", () => {
      // Two rows of one narrow panel each must not pair up onto one line: a row
      // was its own `grid-cols-2` before, and never merged with the next.
      const rows = [row(panel("a", 3)), row(panel("b", 3))];
      expect(boxes(rows, { a: 10, b: 10 }, 2)).toEqual({
        a: ["0%", "50%", 0, 10],
        b: ["0%", "50%", 10, 10],
      });
    });

    test("stacks everything in one column at the narrowest width", () => {
      const rows = [row(panel("a", 6), panel("b", 6)), row(panel("c", 12))];
      expect(boxes(rows, { a: 10, b: 20, c: 30 }, 1)).toEqual({
        a: ["0%", "100%", 0, 10],
        b: ["0%", "100%", 10, 20],
        c: ["0%", "100%", 30, 30],
      });
    });

    test("never lets a panel be wider than the grid it is in", () => {
      const packed = packHome([row(panel("a", 12))], { a: 10 }, 1);
      expect(packed.placements[0]?.width).toBe("100%");
      expect(packed.placements[0]?.left).toBe("0%");
    });
  });
});
