import { describe, expect, test } from "vitest";
import {
  columnFor,
  orderIssues,
  orderStates,
  resolveColumn,
  sortOrderBetween,
} from "../apps/dashboard/src/features/linear/linear-states";
import type { LinearIssue, LinearState } from "../apps/dashboard/src/features/linear/linear-types";

const states: LinearState[] = [
  { id: "done", name: "Done", type: "completed" },
  { id: "todo", name: "Todo", type: "unstarted" },
  { id: "doing", name: "In Progress", type: "started" },
  { id: "dup", name: "Duplicate", type: "duplicate" },
];

const issue = (id: string, stateId: string) =>
  ({ id, state: states.find((entry) => entry.id === stateId) }) as LinearIssue;

describe("board columns", () => {
  test("order follows Linear's state type, and an unknown type sorts last", () => {
    // `duplicate` is not in Linear's documented enum and is real in this
    // workspace — it must appear at the end rather than be dropped.
    expect(orderStates(states).map((state) => state.name)).toEqual([
      "Todo",
      "In Progress",
      "Done",
      "Duplicate",
    ]);
  });

  test("a column id resolves to itself", () => {
    expect(resolveColumn("doing", states, [], null)?.name).toBe("In Progress");
  });

  test("a card with no drag in flight resolves to its stored state", () => {
    const issues = [issue("a", "todo")];
    expect(resolveColumn("a", states, issues, null)?.id).toBe("todo");
  });

  /**
   * The regression. Resolving the dragged card to its *stored* state made the
   * board loop forever: hovering a column moved the card there, the pointer was
   * then over the card itself, resolving that returned the old column, the card
   * moved back — and React hit "maximum update depth exceeded".
   */
  test("the dragged card resolves to where it is being previewed, not where it was", () => {
    const issues = [issue("a", "todo")];
    const preview = { id: "a", stateId: "doing" };
    expect(columnFor(issues[0], preview)).toBe("doing");
    expect(resolveColumn("a", states, issues, preview)?.id).toBe("doing");
    // ...and a card that is not the one being dragged is unaffected.
    const other = issue("b", "todo");
    expect(columnFor(other, preview)).toBe("todo");
  });
});

const placed = (id: string, sortOrder?: number | null) =>
  ({ id, identifier: id, sortOrder }) as LinearIssue;

describe("board order", () => {
  test("a column follows sortOrder, not the order the fetch returned", () => {
    // The fetch is `orderBy: updatedAt`, so this is the order the API hands
    // back; the board must not show it.
    const fetched = [placed("C", 3000), placed("A", 1000), placed("B", 2000)];
    expect(orderIssues(fetched).map((issue) => issue.id)).toEqual(["A", "B", "C"]);
  });

  test("equal orders fall back to the identifier rather than flipping", () => {
    const tied = [placed("B", 1000), placed("A", 1000)];
    expect(orderIssues(tied).map((issue) => issue.id)).toEqual(["A", "B"]);
  });

  test("a missing sortOrder sorts as zero instead of dropping the card", () => {
    const mixed = [placed("A", 10), placed("B", null), placed("C", undefined)];
    expect(orderIssues(mixed)).toHaveLength(3);
    expect(orderIssues(mixed).map((issue) => issue.id)).toEqual(["B", "C", "A"]);
  });

  test("orderIssues does not mutate what it is given", () => {
    const fetched = [placed("C", 3000), placed("A", 1000)];
    orderIssues(fetched);
    expect(fetched.map((issue) => issue.id)).toEqual(["C", "A"]);
  });

  test("a drop between two cards takes the midpoint", () => {
    expect(sortOrderBetween(1000, 2000)).toBe(1500);
  });

  test("a drop at either end steps past the neighbour it has", () => {
    expect(sortOrderBetween(undefined, 1000)).toBe(0);
    expect(sortOrderBetween(1000, undefined)).toBe(2000);
  });

  test("a drop into an empty column is zero rather than NaN", () => {
    expect(sortOrderBetween(undefined, undefined)).toBe(0);
  });

  test("repeated halving keeps every card distinct and in order", () => {
    // One drop writes one field rather than renumbering the column, so the gap
    // halves each time a card is dropped into the same slot.
    let low = 1000;
    const high = 2000;
    const seen: number[] = [];
    for (let drop = 0; drop < 30; drop += 1) {
      low = sortOrderBetween(low, high);
      seen.push(low);
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });
});
