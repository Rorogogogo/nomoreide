import { useEffect, useState } from "react";
import { listSnapshots, type Snapshot } from "@/lib/api";

/**
 * The restore points Home reports on, newest first.
 *
 * A `fetch`-source widget (see the contract in `features/home/widget-types.ts`),
 * and a cheap one: `/api/snapshots` is a single `git for-each-ref` — about 14ms
 * against a repo with thirty of them. That is the distinction that matters when
 * adding widgets, not whether the widget fetches at all: the Agent widget's
 * `mcp-status` costs six seconds because it spawns a CLI that cold-starts every
 * MCP server, and polling *that* on a landing page is what exhausts the
 * browser's six connections per host. This one can poll normally.
 */

export interface HomeSnapshotSummary {
  snapshots: Snapshot[];
  total: number;
  /** Taken in the last 24h — "is there a restore point from *this* session". */
  recent: number;
  /** See the note on `loaded` in `features/agent/use-home-agent-summary.ts`. */
  loaded: boolean;
}

const EMPTY: HomeSnapshotSummary = { snapshots: [], total: 0, recent: 0, loaded: false };

const DAY_MS = 86_400_000;

/** Cheap call, so this is just "keep it current", not a cost decision. */
const POLL_MS = 60_000;

export function useHomeSnapshotSummary(pollMs = POLL_MS): HomeSnapshotSummary {
  const [summary, setSummary] = useState<HomeSnapshotSummary>(EMPTY);

  useEffect(() => {
    let active = true;

    const load = async () => {
      // A repo with no snapshot refs, or no repository selected at all, is a
      // normal state rather than an error to render on the landing page.
      const snapshots = await listSnapshots().catch(() => [] as Snapshot[]);
      if (!active) return;

      const cutoff = Date.now() - DAY_MS;
      setSummary({
        snapshots,
        total: snapshots.length,
        recent: snapshots.filter((snapshot) => {
          const at = Date.parse(snapshot.createdAt);
          return Number.isFinite(at) && at >= cutoff;
        }).length,
        loaded: true,
      });
    };

    void load();
    const interval = window.setInterval(() => void load(), pollMs);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [pollMs]);

  return summary;
}
