import { useCallback, useEffect, useState } from "react";
import {
  executeDatabaseWrite,
  getDatabaseRows,
  getDatabaseTables,
  listDatabases,
  runDatabaseQuery,
  setDatabaseWriteAccess,
  type DatabaseConnection,
  type QueryResult,
  type RowSample,
  type TableRef,
  type WriteOutcome,
} from "@/lib/api";

export function useDatabases() {
  const [connections, setConnections] = useState<DatabaseConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setConnections(await listDatabases());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { connections, loading, error, refresh };
}

export const PAGE_SIZES = [50, 100, 500, 1000] as const;

/** Runs an ad-hoc read-only query and tracks the in-flight / result / error state. */
export function useSqlQuery(connection: string | null) {
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  // A different connection invalidates any prior result.
  useEffect(() => {
    setResult(null);
    setError(null);
  }, [connection]);

  const run = useCallback(
    async (sql: string, limit: number) => {
      if (!connection || !sql.trim()) return;
      setRunning(true);
      setError(null);
      try {
        setResult(await runDatabaseQuery(connection, sql, limit));
      } catch (caught) {
        setResult(null);
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setRunning(false);
      }
    },
    [connection],
  );

  const reset = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  return { result, error, running, run, reset };
}

/** Statements routed through the read-only query path (everything else writes). */
const READ_LEADERS = ["select", "show", "explain", "pragma", "describe", "desc"];

export function isReadStatement(sql: string): boolean {
  const leader = /^\s*([a-z]+)/i.exec(sql)?.[1]?.toLowerCase() ?? "";
  return READ_LEADERS.includes(leader);
}

/**
 * Two-phase write runner: `preview` runs the statement in a rolled-back
 * transaction to surface the affected-row count, then `commit` re-runs and
 * persists. Only reachable once the connection is unlocked.
 */
export function useSqlWrite(connection: string | null) {
  const [pending, setPending] = useState<{ sql: string; preview: WriteOutcome } | null>(
    null,
  );
  const [committed, setCommitted] = useState<WriteOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [committing, setCommitting] = useState(false);

  useEffect(() => {
    setPending(null);
    setCommitted(null);
    setError(null);
  }, [connection]);

  const preview = useCallback(
    async (sql: string) => {
      if (!connection || !sql.trim()) return;
      setPreviewing(true);
      setError(null);
      setCommitted(null);
      try {
        const outcome = await executeDatabaseWrite(connection, sql, "preview");
        setPending({ sql, preview: outcome });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setPreviewing(false);
      }
    },
    [connection],
  );

  const commit = useCallback(async (): Promise<WriteOutcome | null> => {
    if (!connection || !pending) return null;
    setCommitting(true);
    setError(null);
    try {
      const outcome = await executeDatabaseWrite(connection, pending.sql, "commit");
      setCommitted(outcome);
      setPending(null);
      return outcome;
    } catch (caught) {
      // Close the preview so the error surfaces in the result area.
      setPending(null);
      setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    } finally {
      setCommitting(false);
    }
  }, [connection, pending]);

  const cancel = useCallback(() => setPending(null), []);
  const reset = useCallback(() => {
    setPending(null);
    setCommitted(null);
    setError(null);
  }, []);

  return {
    pending,
    committed,
    error,
    previewing,
    committing,
    preview,
    commit,
    cancel,
    reset,
  };
}

/** Toggles a connection's write lock and reports the new state to the caller. */
export function useWriteAccess(connection: string | null, onChange: () => void) {
  const [updating, setUpdating] = useState(false);

  const setUnlocked = useCallback(
    async (unlocked: boolean) => {
      if (!connection) return;
      setUpdating(true);
      try {
        await setDatabaseWriteAccess(connection, unlocked);
        onChange();
      } finally {
        setUpdating(false);
      }
    },
    [connection, onChange],
  );

  return { updating, setUnlocked };
}

/** Tables for a connection + the sampled rows of the currently selected table. */
export function useTableBrowser(connection: string | null) {
  const [tables, setTables] = useState<TableRef[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [sample, setSample] = useState<RowSample | null>(null);
  const [tablesError, setTablesError] = useState<string | null>(null);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [loadingTables, setLoadingTables] = useState(false);
  const [loadingRows, setLoadingRows] = useState(false);
  const [limit, setLimit] = useState<number>(100);
  const [offset, setOffset] = useState(0);

  // A new table or connection always starts back at the first page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on table switch
  useEffect(() => {
    setOffset(0);
  }, [connection, selectedTable]);

  // Reset and load tables whenever the connection changes.
  useEffect(() => {
    setTables([]);
    setSelectedTable(null);
    setSample(null);
    setTablesError(null);
    setRowsError(null);
    if (!connection) return;
    let cancelled = false;
    setLoadingTables(true);
    getDatabaseTables(connection)
      .then((result) => {
        if (cancelled) return;
        setTables(result);
        setSelectedTable(result[0]?.qualifiedName ?? null);
      })
      .catch((caught) => {
        if (!cancelled)
          setTablesError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!cancelled) setLoadingTables(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connection]);

  // Load rows whenever the selected table, page size, or offset changes.
  useEffect(() => {
    setSample(null);
    setRowsError(null);
    if (!connection || !selectedTable) return;
    let cancelled = false;
    setLoadingRows(true);
    getDatabaseRows(connection, selectedTable, limit, offset)
      .then((result) => {
        if (!cancelled) setSample(result);
      })
      .catch((caught) => {
        if (!cancelled)
          setRowsError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!cancelled) setLoadingRows(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connection, selectedTable, limit, offset]);

  // A full page back implies there may be more; the page size selector resets
  // to the first page so offsets never dangle past the new window.
  const canPrev = offset > 0;
  const canNext = sample ? sample.rowCount === limit : false;

  function changePageSize(next: number) {
    setLimit(next);
    setOffset(0);
  }

  function nextPage() {
    if (canNext) setOffset((current) => current + limit);
  }

  function prevPage() {
    setOffset((current) => Math.max(0, current - limit));
  }

  return {
    tables,
    selectedTable,
    setSelectedTable,
    sample,
    tablesError,
    rowsError,
    loadingTables,
    loadingRows,
    limit,
    offset,
    canPrev,
    canNext,
    changePageSize,
    nextPage,
    prevPage,
  };
}
