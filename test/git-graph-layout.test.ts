import { describe, expect, test } from "vitest";
import { assignLanes } from "../src/core/git-graph-layout.js";

describe("assignLanes", () => {
  test("linear history keeps everyone in lane 0", () => {
    const rows = assignLanes([
      { hash: "C", parents: ["B"] },
      { hash: "B", parents: ["A"] },
      { hash: "A", parents: [] },
    ]);

    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows.map((r) => r.laneCount)).toEqual([1, 1, 1]);
    expect(rows[0].edges).toEqual([
      { fromLane: 0, toLane: 0, parentHash: "B", kind: "straight" },
    ]);
    expect(rows[2].edges).toEqual([]);
  });

  test("root commit has no edges", () => {
    const rows = assignLanes([{ hash: "A", parents: [] }]);
    expect(rows[0].edges).toEqual([]);
    expect(rows[0].laneCount).toBe(1);
  });

  test("side branch off main occupies lane 1 until it merges", () => {
    // M(merge of D and B) -> D -> B -> A
    //                              \-> C -> A  (side branch from A)
    // Topo order newest-first:
    const rows = assignLanes([
      { hash: "M", parents: ["D", "C"] },
      { hash: "D", parents: ["B"] },
      { hash: "C", parents: ["A"] },
      { hash: "B", parents: ["A"] },
      { hash: "A", parents: [] },
    ]);

    expect(rows[0].hash).toBe("M");
    expect(rows[0].lane).toBe(0);
    // M's two edges: lane 0 -> 0 (to D, straight) and lane 0 -> 1 (to C, merge)
    expect(rows[0].edges).toEqual([
      { fromLane: 0, toLane: 0, parentHash: "D", kind: "straight" },
      { fromLane: 0, toLane: 1, parentHash: "C", kind: "merge" },
    ]);

    const d = rows.find((r) => r.hash === "D")!;
    expect(d.lane).toBe(0);

    const c = rows.find((r) => r.hash === "C")!;
    expect(c.lane).toBe(1);

    const b = rows.find((r) => r.hash === "B")!;
    expect(b.lane).toBe(0);
    // C already reserved A in lane 1, so B's edge crosses over to merge there.
    expect(b.edges).toEqual([
      { fromLane: 0, toLane: 1, parentHash: "A", kind: "merge" },
    ]);

    const a = rows.find((r) => r.hash === "A")!;
    expect(a.lane).toBe(1);
  });

  test("octopus merge fans out to three lanes", () => {
    const rows = assignLanes([
      { hash: "M", parents: ["P1", "P2", "P3"] },
      { hash: "P1", parents: [] },
      { hash: "P2", parents: [] },
      { hash: "P3", parents: [] },
    ]);

    expect(rows[0].edges).toHaveLength(3);
    expect(rows[0].edges[0]).toMatchObject({ toLane: 0, kind: "straight" });
    expect(rows[0].edges[1]).toMatchObject({ toLane: 1, kind: "merge" });
    expect(rows[0].edges[2]).toMatchObject({ toLane: 2, kind: "merge" });
  });

  test("trailing empty lanes are compacted", () => {
    // After the side branch closes, laneCount should drop back to 1.
    const rows = assignLanes([
      { hash: "M", parents: ["A", "B"] },
      { hash: "B", parents: ["A"] },
      { hash: "A", parents: [] },
    ]);

    const a = rows.find((r) => r.hash === "A")!;
    expect(a.laneCount).toBe(1);
  });

  test("throughLanes marks lanes that continue past a row", () => {
    // M(D, C) -> D -> C -> B -> A
    // While D is being rendered, C's lane should pass through.
    const rows = assignLanes([
      { hash: "M", parents: ["D", "C"] },
      { hash: "D", parents: ["B"] },
      { hash: "C", parents: ["B"] },
      { hash: "B", parents: ["A"] },
      { hash: "A", parents: [] },
    ]);

    const d = rows.find((r) => r.hash === "D")!;
    expect(d.lane).toBe(0);
    expect(d.throughLanes).toEqual([1]); // C still pending in lane 1

    const a = rows.find((r) => r.hash === "A")!;
    expect(a.throughLanes).toEqual([]);
  });

  test("multiple children of same commit converge", () => {
    // Two branches both pointing at A directly:
    //   X -> A
    //   Y -> A
    // Newest-first order with X listed before Y.
    const rows = assignLanes([
      { hash: "X", parents: ["A"] },
      { hash: "Y", parents: ["A"] },
      { hash: "A", parents: [] },
    ]);

    expect(rows[0].lane).toBe(0); // X in lane 0
    expect(rows[1].lane).toBe(1); // Y allocates new lane (A already reserved by X in lane 0)
    expect(rows[1].edges[0]).toMatchObject({ fromLane: 1, toLane: 0, kind: "merge" });

    const a = rows[2];
    expect(a.lane).toBe(0);
    // Both reservations cleared → laneCount compacts back to 1
    expect(a.laneCount).toBe(1);
  });
});
