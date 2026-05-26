import { useCallback, useEffect, useState } from "react";
import {
  getDatabaseRows,
  getDatabaseTables,
  listDatabases,
  type DatabaseConnection,
  type RowSample,
  type TableRef,
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
