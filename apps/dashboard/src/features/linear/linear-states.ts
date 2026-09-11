import type { LinearIssue, LinearState } from "./linear-types";

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
  if (priority === 1) return "text-red-600 dark:text-red-500";
  if (priority === 2) return "text-amber-600 dark:text-amber-500";
  return "text-muted-foreground";
}

/**
 * The row's left edge, by priority — and deliberately only for the top two.
 *
 * Priority answers "what do I look at first", which is a two-state question.
 * Giving all four levels a colour turns a column into a rainbow in which
 * nothing stands out, so Normal, Low and No priority get no edge at all and
 * Urgent and High are the only things that interrupt a scan.
 *
 * Every row reserves the 2px whether or not it is coloured, so a card changing
 * priority does not shift its own text sideways. The colour is redundant with
 * the priority label the row already carries, never the only carrier of it.
 */
export function priorityEdge(priority: number): string {
  if (priority === 1) return "border-l-red-600 dark:border-l-red-500";
  if (priority === 2) return "border-l-amber-500 dark:border-l-amber-400";
  return "border-l-transparent";
}

/**
 * Where the dragged card is pretending to be, while a drag is in flight.
 *
 * `null` when nothing is being dragged.
 */
export type BoardPreview = { id: string; stateId: string } | null;

/** The state a card is in right now, preview included. */
export function columnFor(issue: LinearIssue, preview: BoardPreview): string {
  return preview && preview.id === issue.id ? preview.stateId : issue.state.id;
}

/**
 * The column an id addresses — a column's own id, or the card's current state.
 *
 * **Preview-aware, and that is the whole point.** Resolving a card to its
 * *stored* state instead put the board in an infinite update loop: hovering
 * column B set the preview to B and re-rendered the card into B, at which point
 * the pointer was over the card itself, and resolving that id went back to the
 * stored state — column A. The preview flipped to A, the card moved back, the
 * pointer was over B again, and React gave up with "maximum update depth
 * exceeded". Extracted here so a test holds the invariant instead of a comment.
 */
export function resolveColumn(
  id: string,
  states: LinearState[],
  issues: LinearIssue[],
  preview: BoardPreview,
): LinearState | undefined {
  const column = states.find((state) => state.id === id);
  if (column) return column;
  const issue = issues.find((entry) => entry.id === id);
  return issue && states.find((state) => state.id === columnFor(issue, preview));
}

/**
 * A column's cards, in the order a person put them in.
 *
 * Linear's `sortOrder` ascending, then the identifier so equal orders never
 * flip between renders. Without this a column is whatever order the fetch
 * returned — `orderBy: updatedAt` — so a card dragged into place jumped back
 * to time order the moment anything touched it.
 */
export function orderIssues(issues: LinearIssue[]): LinearIssue[] {
  return [...issues].sort(
    (a, b) =>
      (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.identifier.localeCompare(b.identifier),
  );
}

/** The gap between two neighbours, or a step past the end of the column. */
const STEP = 1000;

/**
 * The `sortOrder` for a card dropped between `before` and `after`.
 *
 * A midpoint rather than a renumbering, so one drop writes one field on one
 * issue instead of rewriting the column. Doubles stay exact for far more
 * halvings than a board will ever see between two neighbours.
 */
export function sortOrderBetween(before?: number | null, after?: number | null): number {
  if (before != null && after != null) return (before + after) / 2;
  if (after != null) return after - STEP;
  if (before != null) return before + STEP;
  return 0;
}
