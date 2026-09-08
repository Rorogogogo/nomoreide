import type { LinearState } from "./linear-types";

/**
 * Linear's workflow-state vocabulary, and what it means here.
 *
 * A state's `name` is the user's own text — "Done", "Shipped", "In QA" — so
 * nothing may key off it. Its `type` is Linear's fixed enum, and that is what
 * decides both the order columns appear in and the colour a status mark gets.
 */
const ORDER = ["triage", "backlog", "unstarted", "started", "completed", "canceled"] as const;

/**
 * Board column order.
 *
 * Linear returns a team's states in no order this cares about, and a board
 * whose columns move between refreshes is unreadable. Sorted by `type` first —
 * left to right is the path work actually takes — and by name inside a type, so
 * two "started" states keep a stable order rather than swapping.
 *
 * An unknown `type` sorts to the end rather than being dropped: a state Linear
 * adds later should appear somewhere, not silently swallow its issues.
 */
export function orderStates(states: LinearState[]): LinearState[] {
  const rank = (state: LinearState) => {
    const index = ORDER.indexOf(state.type as (typeof ORDER)[number]);
    return index === -1 ? ORDER.length : index;
  };
  return [...states].sort(
    (left, right) => rank(left) - rank(right) || left.name.localeCompare(right.name),
  );
}

/**
 * The status mark's colour, from DESIGN.md's fixed table.
 *
 * `started` is amber because it is in progress, `completed` emerald, `canceled`
 * zinc for inert. Backlog and triage are parked rather than wrong, so they take
 * the muted foreground rather than a saturated colour — saturated colour is for
 * status, and "not started yet" is the absence of status.
 */
export function stateTone(type: string): string {
  if (type === "started") return "text-amber-500";
  if (type === "completed") return "text-emerald-500";
  if (type === "canceled") return "text-zinc-500";
  return "text-muted-foreground";
}

/** Linear's priority scale. 0 is "none", and 1 is the *most* urgent. */
export const PRIORITIES = [0, 1, 2, 3, 4] as const;

/** Urgent earns red; everything else stays quiet. */
export function priorityTone(priority: number): string {
  return priority === 1 ? "text-red-600 dark:text-red-500" : "text-muted-foreground";
}
