import { describe, expect, test } from "vitest";
import {
  clampX,
  gridRows,
  type HomeTile,
  packTiles,
  rowsForPx,
} from "../apps/dashboard/src/features/home/home-grid";

/**
 * The page as rectangles.
 *
 * Every test here is one of the two things the old row model could not say:
 * *does a panel fill the hole beside a tall one*, and *does a panel squeeze
 * aside rather than being pushed under*. Those were reported as a resize that
 * did nothing and a drop that would not land, and they are the same missing
 * idea — a row has no way to hold the answer.
 */

function tile(x: number, y: number, w: number, h: number | null = null): HomeTile {
  return { x, y, w, h };
}

/** Placements as `id -> [x, y, w, h]`, which is what every assert here wants. */
function pack(
  entries: Record<string, [HomeTile, number?]>,
  columns = 12,
): Record<string, [number, number, number, number]> {
  const placements = packTiles(
    Object.entries(entries).map(([id, [t, rows]]) => ({ id, tile: t, measuredRows: rows ?? 2 })),
    columns,
  );
  const out: Record<string, [number, number, number, number]> = {};
  for (const p of placements) out[p.id] = [p.x, p.y, p.w, p.h];
  return out;
}

describe("packTiles", () => {
  test("keeps a row of three side by side", () => {
    const out = pack({
      a: [tile(0, 0, 4, 2)],
      b: [tile(4, 0, 4, 2)],
      c: [tile(8, 0, 4, 2)],
    });
    expect(out).toEqual({ a: [0, 0, 4, 2], b: [4, 0, 4, 2], c: [8, 0, 4, 2] });
  });

  test("fills the hole beside a tall panel instead of leaving dead page", () => {
    // The reported shape: a tall Logs on the right, two short panels on the
    // left, and a full-width panel below with nowhere to go but the bottom.
    const out = pack({
      services: [tile(0, 0, 4, 2)],
      logs: [tile(8, 0, 4, 8)],
      conversations: [tile(0, 8, 12, 3)],
    });
    // Not row 8: it rises into the band under the short panel and beside the
    // tall one, narrowed to the eight columns actually free there. It does not
    // fold down to the four-column crack left of the tall panel — see the floor
    // on narrowing, which is what keeps a wide panel recognisably wide.
    expect(out.conversations).toEqual([0, 2, 8, 3]);
    expect(out.logs).toEqual([8, 0, 4, 8]);
  });

  test("squeezes a panel beside a tall one rather than pushing it under", () => {
    // What "it should squeeze the conversation to the left" means: eight
    // columns are free next to the tall panel, so the wide one takes them and
    // keeps its line instead of dropping below.
    const out = pack({
      logs: [tile(8, 0, 4, 10)],
      conversations: [tile(0, 1, 12, 3)],
    });
    expect(out.conversations).toEqual([0, 0, 8, 3]);
  });

  test("wraps when the run left beside it is too narrow to be a panel", () => {
    // Ten columns taken leaves two, and two is below `MIN_SPAN` — there is no
    // panel that narrow, so this one belongs on the next line.
    const out = pack({
      wide: [tile(0, 0, 10, 4)],
      other: [tile(10, 0, 6, 2)],
    });
    expect(out.other[1]).toBe(4);
    expect(out.other[2]).toBe(6);
  });

  test("never overlaps, whatever the stored rectangles say", () => {
    // Two panels stored on top of each other — the state a drop produces before
    // anything has been resolved.
    const out = pack({ a: [tile(0, 0, 6, 4)], b: [tile(0, 0, 6, 4)] });
    expect(out.a).toEqual([0, 0, 6, 4]);
    // Beside, not on top of — and never the same columns on the same rows.
    expect(out.b).toEqual([6, 0, 6, 4]);
  });

  test("reads down the page and then across", () => {
    // Reading order decides who gets the good spot, and it is the order the
    // page is read in — not the order the ids happen to be stored in.
    const out = pack({
      late: [tile(0, 5, 6, 2)],
      early: [tile(6, 0, 6, 2)],
    });
    expect(out.early).toEqual([6, 0, 6, 2]);
    expect(out.late).toEqual([0, 0, 6, 2]);
  });

  test("an unsized panel is as tall as it measured", () => {
    const out = pack({ a: [tile(0, 0, 12, null), 5] });
    expect(out.a[3]).toBe(5);
  });

  test("collapses the grid to fewer columns without overlapping", () => {
    const out = pack({ a: [tile(0, 0, 6, 2)], b: [tile(6, 0, 6, 2)] }, 4);
    expect(out.a).toEqual([0, 0, 4, 2]);
    expect(out.b).toEqual([0, 2, 4, 2]);
  });
});

describe("rowsForPx", () => {
  test("rounds up, because half a row of content still needs a row", () => {
    expect(rowsForPx(65)).toBe(3);
    expect(rowsForPx(64)).toBe(2);
  });

  test("never goes below the floor, including for an unmeasured panel", () => {
    expect(rowsForPx(0)).toBe(2);
    expect(rowsForPx(Number.NaN)).toBe(2);
  });
});

describe("clampX", () => {
  test("keeps a panel's right edge on the page", () => {
    expect(clampX(11, 4, 12)).toBe(8);
    expect(clampX(-3, 4, 12)).toBe(0);
  });
});

describe("gridRows", () => {
  test("is the lowest edge anything reaches, not the sum", () => {
    expect(gridRows([{ id: "a", x: 0, y: 0, w: 6, h: 4 }, { id: "b", x: 6, y: 0, w: 6, h: 9 }])).toBe(9);
  });
});

describe("the gaps it leaves", () => {
  test("never strands a strip too narrow to hold a panel", () => {
    // A rectangle can sit two columns in from the edge and strand them for the
    // height of the page — nothing may be narrower than MIN_SPAN, so nothing
    // could ever fill them. This is the one guarantee the row model gave for
    // free, and the only one worth carrying over.
    const out = pack({ a: [tile(2, 0, 6, 3)], b: [tile(0, 9, 4, 2)] });
    expect(out.a).toEqual([0, 0, 6, 3]);
  });

  test("keeps what is left over in one piece when it cannot be avoided", () => {
    // Six columns free and a panel wanting four: two are stranded whatever
    // happens. What must not happen is *both* sides being stranded — a column
    // here and a column there is two dead strips instead of one.
    const out = pack({ a: [tile(0, 0, 6, 4)], b: [tile(7, 0, 4, 2)] });
    expect(out.b).toEqual([6, 0, 4, 2]);
  });
});
