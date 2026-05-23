export interface GitGraphCommitInput {
  hash: string;
  parents: string[];
}

export type GitGraphEdgeKind = "straight" | "branch" | "merge";

export interface GitGraphEdge {
  fromLane: number;
  toLane: number;
  parentHash: string;
  kind: GitGraphEdgeKind;
}

export interface GitGraphLayoutRow {
  hash: string;
  lane: number;
  laneCount: number;
  edges: GitGraphEdge[];
  /** Lanes (other than this commit's lane) that continue past this row — they need a vertical pass-through line. */
  throughLanes: number[];
}

/**
 * Assigns lanes and edges to a topologically ordered list of commits
 * (newest first, as `git log` emits). Pure function — no git access.
 *
 * Algorithm: maintain an array of "active lanes". Each slot holds the hash
 * of the commit expected to appear next in that lane (i.e. a child waiting
 * for its parent). For each commit we:
 *   1. Pick the leftmost lane reserving this commit's hash (else allocate one).
 *   2. Replace that slot with the commit's first parent (or null if root).
 *   3. For additional parents, try to reuse an existing slot already
 *      reserving that parent; otherwise allocate a new lane.
 *   4. Emit edges from this row down to each parent's lane.
 *   5. Compact trailing nulls so lane count doesn't grow unbounded.
 */
export function assignLanes(commits: GitGraphCommitInput[]): GitGraphLayoutRow[] {
  const rows: GitGraphLayoutRow[] = [];
  const active: (string | null)[] = [];

  for (const commit of commits) {
    let lane = active.indexOf(commit.hash);
    if (lane === -1) {
      lane = firstFreeLane(active);
      if (lane === active.length) {
        active.push(null);
      }
    }

    // Clear every reservation for this commit hash (a commit can have
    // multiple children waiting on it — they all converge here).
    for (let i = 0; i < active.length; i++) {
      if (active[i] === commit.hash) {
        active[i] = null;
      }
    }

    const edges: GitGraphEdge[] = [];
    const [firstParent, ...rest] = commit.parents;

    if (firstParent) {
      const existing = active.indexOf(firstParent);
      let parentLane: number;
      if (existing !== -1) {
        parentLane = existing;
      } else {
        parentLane = lane;
        active[parentLane] = firstParent;
      }
      edges.push({
        fromLane: lane,
        toLane: parentLane,
        parentHash: firstParent,
        kind: parentLane === lane ? "straight" : "merge",
      });
    }

    for (const parent of rest) {
      let parentLane = active.indexOf(parent);
      if (parentLane === -1) {
        parentLane = firstFreeLane(active);
        if (parentLane === active.length) {
          active.push(null);
        }
        active[parentLane] = parent;
      }
      edges.push({
        fromLane: lane,
        toLane: parentLane,
        parentHash: parent,
        kind: parentLane === lane ? "straight" : "merge",
      });
    }

    const throughLanes: number[] = [];
    for (let i = 0; i < active.length; i++) {
      if (i !== lane && active[i] !== null) {
        throughLanes.push(i);
      }
    }

    rows.push({
      hash: commit.hash,
      lane,
      laneCount: Math.max(lane + 1, active.length),
      edges,
      throughLanes,
    });

    compactTrailingNulls(active);
  }

  return rows;
}

function firstFreeLane(active: (string | null)[]): number {
  const idx = active.indexOf(null);
  return idx === -1 ? active.length : idx;
}

function compactTrailingNulls(active: (string | null)[]): void {
  while (active.length > 0 && active[active.length - 1] === null) {
    active.pop();
  }
}
