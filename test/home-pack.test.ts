import { describe, expect, test } from "vitest";
import { HOME_ROW_PX, type PlacedRow, type PlacedWidget } from "../src/web/client/src/features/home/home-layout";
import {
  gridColumns,
  packHome,
  previewResize,
  previewPlacement,
  spanFor,
  HOME_MID_WIDTH,
  HOME_WIDE_WIDTH,
} from "../src/web/client/src/features/home/home-pack";
import type { HomeLayout } from "../src/web/client/src/features/settings/ui-preferences";
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

/** Placements as `id -> [column, span, lanes, top, height]` — what most asserts want. */
function boxes(rows: PlacedRow[], measured: Record<string, number>, columns: number) {
  const out: Record<string, [number, number, number, number, number]> = {};
  for (const place of packHome(rows, measured, columns).placements) {
    out[place.id] = [place.column, place.span, place.lanes, place.top, place.height];
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
      { id: "a", column: 0, span: 12, lanes: 12, top: 0, height: 90, fixed: false },
    ]);
    expect(packed.height).toBe(90);
  });

  test("places a row left to right as shares of the grid", () => {
    const rows = [row(panel("a", 3), panel("b", 4), panel("c", 5))];
    expect(boxes(rows, { a: 50, b: 50, c: 50 }, 12)).toEqual({
      a: [0, 3, 12, 0, 50],
      b: [3, 4, 12, 0, 50],
      c: [7, 5, 12, 0, 50],
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

  /**
   * The other half of the raggedness rule.
   *
   * Masonry lets columns end at different depths on purpose, but a few pixels
   * apart is not a difference anyone chose — it is a dragged height in row units
   * failing to agree with a fitted one in text. Those are levelled; anything
   * further apart is left exactly where the skyline put it.
   */
  describe("levelling a near-miss", () => {
    const heights = (rows: PlacedRow[], measured: Record<string, number>, columns = 12) => {
      const out: Record<string, number> = {};
      for (const place of packHome(rows, measured, columns).placements) out[place.id] = place.height;
      return out;
    };

    test("levels two panels side by side, with nothing arriving below them", () => {
      // The case this came from. `b` ends one pixel above `a`, and the panel
      // under `a` covers only `a`'s columns — so nothing is ever drawn across
      // the pair. If levelling waited for something to span them, the two edges
      // would stay one pixel apart for as long as the page existed.
      const rows = [row(panel("a", 6), panel("b", 6)), row(panel("c", 6))];
      expect(heights(rows, { a: 256, b: 257, c: 192 })).toEqual({ a: 257, b: 257, c: 192 });
      // And `c` starts on the line `a` now ends at, not the one it used to.
      expect(tops(rows, { a: 256, b: 257, c: 192 })).toEqual({ a: 0, b: 0, c: 257 });
    });

    test("grows the panel that ends just short of the line beside it", () => {
      const rows = [row(panel("a", 6), panel("b", 6)), row(panel("c", 12))];
      // `b` is 7px short of `a`, and `c` is about to draw one straight edge
      // across both. It ends where `a` does, and `c` still starts where it would
      // have — levelling only ever fills the sliver, it never pushes anything
      // down.
      expect(heights(rows, { a: 200, b: 193, c: 50 })).toEqual({ a: 200, b: 200, c: 50 });
      expect(tops(rows, { a: 200, b: 193, c: 50 })).toEqual({ a: 0, b: 0, c: 200 });
    });

    test("leaves a difference big enough to have been meant", () => {
      // Nothing below to seal the space, so the shorter column simply ends
      // earlier — which is the whole point of packing this way.
      const rows = [row(panel("a", 6), panel("b", 6))];
      expect(heights(rows, { a: 200, b: 160 })).toEqual({ a: 200, b: 160 });
    });

    test("gives away the space a panel below has sealed off, however big", () => {
      // `c` covers both columns, so nothing can ever be placed in the 40px under
      // `b` — it is a hole with a lid on it, not a column that ended early, and
      // it takes the top edge off `c` for as long as it is there.
      const rows = [row(panel("a", 6), panel("b", 6)), row(panel("c", 12))];
      expect(heights(rows, { a: 200, b: 160, c: 50 })).toEqual({ a: 200, b: 200, c: 50 });
    });

    test("still lets a panel rise into a column that stays open", () => {
      // The sealing rule must not swallow the reason masonry exists. `d` covers
      // only `b`'s columns, so `b` keeps the depth its own content gave it and
      // `d` starts there — 140px above where a row would have put it.
      const rows = [row(panel("a", 6), panel("b", 6)), row(panel("c", 6), panel("d", 6))];
      const measured = { a: 200, b: 60, c: 30, d: 90 };
      expect(heights(rows, measured)).toEqual({ a: 200, b: 60, c: 30, d: 90 });
      expect(tops(rows, measured)).toEqual({ a: 0, b: 0, c: 200, d: 60 });
    });

    test("levels the page's own bottom edge, with nothing below to do it", () => {
      // The last line on the page is a line too: two panels ending 7px apart
      // above the footer read exactly as badly as two ending 7px apart above a
      // third.
      const rows = [row(panel("a", 6), panel("b", 6))];
      const packed = packHome(rows, { a: 200, b: 193 }, 12);
      expect(packed.height).toBe(200);
      expect(packed.placements.map((place) => place.height)).toEqual([200, 200]);
    });

    test("never grows a panel that something has already been placed under", () => {
      // `b` sits under half of `a`, so the 8px `a` is short of the page's bottom
      // edge cannot be given to it — `a` would grow straight through `b`. The
      // sliver stays, which is the right answer: it is the only one that is not
      // an overlap.
      const rows = [row(panel("a", 12)), row(panel("b", 6))];
      expect(heights(rows, { a: 100, b: 8 })).toEqual({ a: 100, b: 8 });
      expect(packHome(rows, { a: 100, b: 8 }, 12).height).toBe(108);
    });

    test("levels a fitted panel onto a dragged one, which is where this comes from", () => {
      // A height is stored in whole `HOME_ROW_PX` rows; content is however tall
      // it came out. Two panels meant to end together, off by five pixels.
      const rows = [row(panel("a", 6, 4), panel("b", 6)), row(panel("c", 12))];
      const measured = { b: 4 * HOME_ROW_PX - 5, c: 30 };
      expect(heights(rows, measured)).toEqual({
        a: 4 * HOME_ROW_PX,
        b: 4 * HOME_ROW_PX,
        c: 30,
      });
    });
  });

  describe("below the wide breakpoint", () => {
    test("puts two panels per line and wraps within the row", () => {
      const rows = [row(panel("a", 3), panel("b", 3), panel("c", 3), panel("d", 3))];
      // Heights far enough apart that none of this is levelling (`HOME_SNAP_PX`)
      // — the question here is only which line each panel wraps onto.
      expect(boxes(rows, { a: 100, b: 200, c: 100, d: 100 }, 2)).toEqual({
        a: [0, 1, 2, 0, 100],
        b: [1, 1, 2, 0, 200],
        c: [0, 1, 2, 100, 100],
        d: [1, 1, 2, 200, 100],
      });
    });

    test("starts each stored row on its own line, as its own grid used to", () => {
      // Two rows of one narrow panel each must not pair up onto one line: a row
      // was its own `grid-cols-2` before, and never merged with the next.
      const rows = [row(panel("a", 3)), row(panel("b", 3))];
      expect(boxes(rows, { a: 10, b: 10 }, 2)).toEqual({
        a: [0, 1, 2, 0, 10],
        b: [0, 1, 2, 10, 10],
      });
    });

    test("stacks everything in one column at the narrowest width", () => {
      const rows = [row(panel("a", 6), panel("b", 6)), row(panel("c", 12))];
      expect(boxes(rows, { a: 10, b: 20, c: 30 }, 1)).toEqual({
        a: [0, 1, 1, 0, 10],
        b: [0, 1, 1, 10, 20],
        c: [0, 1, 1, 30, 30],
      });
    });

    test("never lets a panel be wider than the grid it is in", () => {
      const packed = packHome([row(panel("a", 12))], { a: 10 }, 1);
      expect(packed.placements[0]?.column).toBe(0);
      expect(packed.placements[0]?.span).toBe(1);
      expect(packed.placements[0]?.lanes).toBe(1);
    });
  });
});

/**
 * What the drag draws before you let go.
 *
 * The frame is only worth anything if it is the drop's own answer rather than a
 * second guess at it, so these check the rectangle against what the move
 * actually does: a panel joining a row of two comes back a third of the grid
 * wide because that is what the row re-shares, not because the preview
 * approximated it.
 */
/**
 * And what the *resize* draws before you let go.
 *
 * A width was enough while a panel could only grow rightwards. It stopped being
 * enough when it could grow the other way — taking columns from the neighbour on
 * its left, or asking for the whole grid and starting again at the first column
 * — because then the frame's left edge is part of the answer.
 */
describe("previewResize", () => {
  const REGISTRY = [panel("a", 4).widget, panel("b", 4).widget, panel("c", 4).widget];
  const LAYOUT: HomeLayout = {
    rows: [["a", "b", "c"]],
    spans: { a: 4, b: 4, c: 4 },
    heights: {},
  };

  test("keeps the left edge when the columns come from the right", () => {
    expect(previewResize(REGISTRY, LAYOUT, "a", 6, 12)).toMatchObject({ column: 0, span: 6 });
  });

  test("moves the left edge when the panel is the one at the end of the row", () => {
    // `c` ends at the grid's right edge already, so the only place its new
    // columns can come from is the panel on its left — it grows leftwards, and a
    // frame drawn from where it is now would show the growth on the wrong side.
    expect(previewResize(REGISTRY, LAYOUT, "c", 6, 12)).toMatchObject({ column: 6, span: 6 });
  });

  test("starts at the first column for a panel asking for the whole grid", () => {
    expect(previewResize(REGISTRY, LAYOUT, "c", 12, 12)).toMatchObject({ column: 0, span: 12 });
  });

  test("answers in the columns the window actually has", () => {
    expect(previewResize(REGISTRY, LAYOUT, "a", 6, 1)).toMatchObject({ column: 0, span: 1, lanes: 1 });
  });

  test("has nothing to promise for a widget the layout does not show", () => {
    expect(previewResize(REGISTRY, LAYOUT, "missing", 6, 12)).toBeNull();
  });
});

describe("previewPlacement", () => {
  const REGISTRY = [
    panel("a", 4).widget,
    panel("b", 6).widget,
    panel("c", 12).widget,
  ];
  const LAYOUT: HomeLayout = {
    rows: [["a", "b"], ["c"]],
    spans: { a: 6, b: 6, c: 12 },
    heights: {},
  };
  const MEASURED = { a: 100, b: 60, c: 40 };

  test("gives the width the row will re-share, not the one it had", () => {
    // `c` is a full-width row of its own; joining `a` and `b` makes three
    // panels, so all three become four columns and `c` lands in the last four.
    expect(
      previewPlacement(REGISTRY, LAYOUT, "c", { row: 0, index: 2, newRow: false }, MEASURED, 12),
    ).toEqual({ id: "c", column: 8, span: 4, lanes: 12, top: 0, height: 40, fixed: false });
  });

  test("gives a full-width rectangle at the top for a new leading row", () => {
    expect(
      previewPlacement(REGISTRY, LAYOUT, "c", { row: 0, index: 0, newRow: true }, MEASURED, 12),
    ).toEqual({ id: "c", column: 0, span: 12, lanes: 12, top: 0, height: 40, fixed: false });
  });

  test("puts a new trailing row below everything that will be left above it", () => {
    // `a` leaves row 0, so `b` widens to the whole grid and the page above the
    // new row is 60 + 40 tall. The frame has to know that, not where `a` is now.
    expect(
      previewPlacement(REGISTRY, LAYOUT, "a", { row: 2, index: 0, newRow: true }, MEASURED, 12),
    ).toEqual({ id: "a", column: 0, span: 12, lanes: 12, top: 100, height: 100, fixed: false });
  });

  test("previews against the narrow grid when that is what is on screen", () => {
    expect(
      previewPlacement(REGISTRY, LAYOUT, "c", { row: 0, index: 0, newRow: true }, MEASURED, 1),
    ).toEqual({ id: "c", column: 0, span: 1, lanes: 1, top: 0, height: 40, fixed: false });
  });

  test("has nothing to promise for a widget the layout does not show", () => {
    expect(
      previewPlacement(REGISTRY, LAYOUT, "missing", { row: 0, index: 0, newRow: false }, MEASURED, 12),
    ).toBeNull();
  });
});

/**
 * A dragged corner is the one height on the page somebody chose on purpose, and
 * the levelling rules must leave it alone.
 *
 * This is the shape the bug was reported in: Logs sitting beside a taller panel
 * with a full-width row underneath. Every panel in that row is stretched down
 * onto the line the widest one closes off — which is right for panels nobody
 * sized, and wrong for the one whose corner was just dragged. The stored height
 * and the body both said 64px while the slot around them stayed 257, so the
 * panel on screen never changed size and the gesture read as broken.
 */
describe("a height the user chose", () => {
  test("is not stretched to match a taller panel beside it", () => {
    const rows = [
      row(panel("tall", 4, 8), panel("auto", 4), panel("short", 4, 2)),
      row(panel("below", 12)),
    ];
    const packed = boxes(rows, { auto: 57, below: 151 }, 12);

    // What the drag asked for, exactly — not the 256 of the panel beside it.
    expect(packed.short[4]).toBe(2 * HOME_ROW_PX);
    expect(packed.tall[4]).toBe(8 * HOME_ROW_PX);
    // The unsized one is still levelled: that is the rule this is an exception to.
    expect(packed.auto[4]).toBe(8 * HOME_ROW_PX);
    // And the row underneath still clears the tallest of them.
    expect(packed.below[3]).toBe(8 * HOME_ROW_PX);
  });

  test("still holds up whatever lands under it", () => {
    // Being unstretchable must not make a panel weightless — a full-width row
    // below has to clear it, or the two would overlap.
    const rows = [row(panel("sized", 12, 5)), row(panel("under", 12))];
    expect(tops(rows, { under: 40 }).under).toBe(5 * HOME_ROW_PX);
  });
});
