import { useEffect, useState } from "react";
import { Database, Loader2, Plus, Table2 } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToasts } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { deleteDatabase, type DatabaseConnection } from "@/lib/api";
import { AddConnectionDialog, type EditTarget } from "./add-connection-dialog";
import { ConnectionSelector } from "./connection-selector";
import { TableGrid } from "./table-grid";
import { PAGE_SIZES, useDatabases, useTableBrowser } from "./use-databases";

type Dialog = { mode: "add" } | { mode: "edit"; target: EditTarget } | null;

export function DatabaseView() {
  const { connections, loading, error, refresh } = useDatabases();
  const { error: showError, success: showSuccess } = useToasts();
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);

  // Keep a valid selection as the connection list changes.
  useEffect(() => {
    if (connections.length === 0) {
      setSelected(null);
      return;
    }
    setSelected((current) =>
      current && connections.some((c) => c.name === current)
        ? current
        : connections[0].name,
    );
  }, [connections]);

  async function remove(name: string) {
    try {
      await deleteDatabase(name);
      showSuccess(`Removed connection "${name}".`);
      await refresh();
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function startEdit(connection: DatabaseConnection) {
    setDialog({ mode: "edit", target: connection });
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-card/85">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <Database className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Databases</span>
          {loading && connections.length === 0 ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          ) : null}
        </div>
        <ConnectionSelector
          connections={connections}
          selected={selected}
          onSelect={setSelected}
          onAdd={() => setDialog({ mode: "add" })}
          onEdit={startEdit}
          onRemove={(name) => void remove(name)}
        />
      </header>

      <div className="min-h-0 flex-1">
        {error ? (
          <div className="p-4">
            <Alert variant="muted" className="border-destructive/40 text-destructive">
              {error}
            </Alert>
          </div>
        ) : selected ? (
          <ConnectionBrowser connection={selected} />
        ) : (
          <EmptyState onAdd={() => setDialog({ mode: "add" })} />
        )}
      </div>

      {dialog ? (
        <AddConnectionDialog
          initial={dialog.mode === "edit" ? dialog.target : undefined}
          onClose={() => setDialog(null)}
          onSaved={refresh}
        />
      ) : null}
    </div>
  );
}

function ConnectionBrowser({ connection }: { connection: string }) {
  const {
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
  } = useTableBrowser(connection);

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-56 shrink-0 flex-col border-r border-border">
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <Table2 className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Tables</span>
          <Badge variant="outline" size="small">
            {tables.length}
          </Badge>
          {loadingTables ? <Loader2 className="size-3.5 animate-spin" /> : null}
        </div>
        {tablesError ? (
          <div className="p-3">
            <Alert variant="muted" className="border-destructive/40 text-destructive">
              {tablesError}
            </Alert>
          </div>
        ) : (
          <ul className="min-h-0 flex-1 overflow-auto">
            {tables.map((table) => (
              <li key={table.qualifiedName}>
                <button
                  type="button"
                  onClick={() => setSelectedTable(table.qualifiedName)}
                  className={cn(
                    "w-full truncate px-3 py-1.5 text-left font-mono text-[11px] transition-colors hover:bg-muted/50",
                    table.qualifiedName === selectedTable && "bg-muted/70 font-semibold",
                  )}
                >
                  {table.qualifiedName}
                </button>
              </li>
            ))}
            {!loadingTables && tables.length === 0 ? (
              <li className="px-3 py-2 text-xs text-muted-foreground">No tables.</li>
            ) : null}
          </ul>
        )}
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
          <span className="truncate font-mono text-xs font-semibold">
            {selectedTable ?? "Select a table"}
          </span>
          {sample ? (
            <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
              <span className="tabular-nums">
                {sample.rowCount === 0
                  ? "no rows"
                  : `rows ${offset + 1}–${offset + sample.rowCount}`}
              </span>
              <select
                aria-label="Rows per page"
                className="rounded-md border border-border bg-background px-1.5 py-0.5 text-[11px]"
                value={limit}
                onChange={(event) => changePageSize(Number(event.target.value))}
              >
                {PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size} / page
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2"
                onClick={prevPage}
                disabled={!canPrev}
                type="button"
              >
                Prev
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2"
                onClick={nextPage}
                disabled={!canNext}
                type="button"
              >
                Next
              </Button>
            </div>
          ) : null}
        </div>
        {rowsError ? (
          <div className="p-4">
            <Alert variant="muted" className="border-destructive/40 text-destructive">
              {rowsError}
            </Alert>
          </div>
        ) : loadingRows ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            Loading rows…
          </div>
        ) : sample ? (
          <TableGrid connection={connection} sample={sample} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Pick a table to sample its rows.
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center">
      <div className="max-w-sm">
        <Database className="mx-auto size-8 text-muted-foreground/50" />
        <p className="mt-3 text-sm font-medium">No connections yet</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Add a read-only Postgres, MySQL, or SQLite connection to browse tables and sample rows.
          NoMoreIDE can auto-detect connection strings from your services' <code>.env</code> files.
        </p>
        <Button className="mt-4" size="sm" onClick={onAdd} type="button">
          <Plus />
          Add connection
        </Button>
      </div>
    </div>
  );
}
