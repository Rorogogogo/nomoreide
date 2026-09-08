import { describe, expect, test } from "vitest";
import {
  columnFor,
  orderStates,
  resolveColumn,
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
