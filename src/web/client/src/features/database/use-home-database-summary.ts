import { useEffect, useState } from "react";
import { listDatabases, type DatabaseConnection } from "@/lib/api";

/**
 * The registered database connections, and how many of them can currently be
 * written to.
 *
 * `/api/databases` reads the config file and masks passwords — about 2ms, and
 * it never touches the databases themselves. That is deliberate on the server's
 * part and worth preserving here: a Home widget that probed each connection for
 * liveness would be the `mcp-status` mistake again, holding the page's one
 * spare connection open for seconds at a time.
 */

export interface HomeDatabaseSummary {
  connections: DatabaseConnection[];
  total: number;
  /** Connections with writes unlocked — see `core/db-write.ts`. */
  unlocked: number;
  /** See the note on `loaded` in `features/agent/use-home-agent-summary.ts`. */
  loaded: boolean;
}

const EMPTY: HomeDatabaseSummary = { connections: [], total: 0, unlocked: 0, loaded: false };

/** Cheap call, so this is just "keep it current", not a cost decision. */
const POLL_MS = 60_000;

export function useHomeDatabaseSummary(pollMs = POLL_MS): HomeDatabaseSummary {
  const [summary, setSummary] = useState<HomeDatabaseSummary>(EMPTY);

  useEffect(() => {
    let active = true;

    const load = async () => {
      // No databases registered is the normal state for most projects.
      const connections = await listDatabases().catch(() => [] as DatabaseConnection[]);
      if (!active) return;

      setSummary({
        connections,
        total: connections.length,
        unlocked: connections.filter((connection) => connection.writeUnlocked).length,
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
