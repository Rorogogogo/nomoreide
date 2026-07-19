import { useEffect, useMemo, useState } from "react";
import { Database, Loader2, Plus, Sparkles, Table2, Terminal } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToasts } from "@/components/ui/toast";
import { useRegisterRefresh } from "@/components/refresh-registry";
import { cn } from "@/lib/utils";
import { usePersistentState } from "@/lib/use-persistent-state";
import { useOptionalSettings } from "@/features/settings/settings-context";
import {
  deleteDatabase,
  type DatabaseConnection,
  type GitRepositoryDefinition,
  type RowSample,
  type TableRef,
} from "@/lib/api";
import { connectionInScope, pathInScope } from "../services/project-scope";
import { useAgentDock } from "../agent/chat/agent-context";
import { AiSpark } from "../agent/ai-spark";
import { DATABASE_SETUP_PROMPT, buildTablePrompt } from "../agent/prompts";
import { AddConnectionDialog, type EditTarget } from "./add-connection-dialog";
import { ConnectionSelector } from "./connection-selector";
import { DbAddMenu } from "./db-add-menu";
import { SqlConsole } from "./sql-console";
import { TableGrid } from "./table-grid";
import {
  databaseLimitOptions,
  useDatabases,
  useTableBrowser,
} from "./use-databases";

type Dialog = { mode: "add" } | { mode: "edit"; target: EditTarget } | null;
type ViewMode = "browse" | "query";

export function DatabaseView({
  staged,
  onStageConsumed,
  projects = [],
  scopePath = null,
}: {
  /** A write the dock agent drafted, routed here to seed the SQL console. */
  staged?: { connection: string; sql: string; nonce: number } | null;
  onStageConsumed?: () => void;
  /** Registered git projects, for classifying connections. */
  projects?: GitRepositoryDefinition[];
  /** Active project scope; unassigned connections stay visible when set. */
  scopePath?: string | null;
} = {}) {
  const settings = useOptionalSettings();
  const databasePreferences = settings?.confirmedProject.database ?? {
    confirmWrites: true,
    resultLimit: 100,
  };
  const { connections: allConnections, loading, error, refresh } = useDatabases();
  const connections = useMemo(
    () =>
      allConnections.filter((connection) =>
        connectionInScope(connection.projectPath, scopePath),
      ),
    [allConnections, scopePath],
  );
  // "api-server" beats "/Users/x/repo/api-server" as a row tag.
  const projectLabel = (connection: DatabaseConnection): string | null => {
    if (!connection.projectPath) return null;
    const repo = projects.find((project) =>
      pathInScope(connection.projectPath, project.path),
    );
    return repo?.name ?? connection.projectPath.split("/").pop() ?? null;
  };
  useRegisterRefresh(refresh);
  const { error: showError, success: showSuccess } = useToasts();
  const { sendToAgent } = useAgentDock();
  // Sticky so returning to Database keeps your connection and Browse/SQL choice.
  const [selected, setSelected] = usePersistentState<string | null>(
    "database:selected",
    null,
  );
  const [mode, setMode] = usePersistentState<ViewMode>("database:mode", "browse");
  const [dialog, setDialog] = useState<Dialog>(null);
  // One-shot seed handed to the SQL console when a write is staged from the dock.
  const [seed, setSeed] = useState<{ sql: string; nonce: number } | null>(null);

  // A staged write from the dock: jump to its connection, flip to the SQL tab,
  // and hand the statement to the console. Consume it so a later revisit is
  // clean — the user's edits in the editor then stand on their own.
  useEffect(() => {
    if (!staged) return;
    if (staged.connection) setSelected(staged.connection);
    setMode("query");
    setSeed({ sql: staged.sql, nonce: staged.nonce });
    onStageConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staged?.nonce]);

  function addWithAi() {
    sendToAgent({
      prompt: DATABASE_SETUP_PROMPT,
      source: { type: "database-setup", label: "Add a database" },
      label: "Help me connect a database, one step at a time.",
    });
  }

  // Keep a valid selection as the connection list changes. The persisted name
  // may point at a connection that's since been removed (or not yet loaded), so
  // fall back to the first available one.
  useEffect(() => {
    if (connections.length === 0) {
      if (selected !== null) setSelected(null);
      return;
    }
    if (!selected || !connections.some((c) => c.name === selected)) {
      setSelected(connections[0].name);
    }
  }, [connections, selected, setSelected]);

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
        <div className="flex items-center gap-2">
          {selected ? <ViewModeToggle mode={mode} onChange={setMode} /> : null}
          <ConnectionSelector
            connections={connections}
            projectLabel={projectLabel}
            selected={selected}
            onSelect={setSelected}
            onAdd={() => setDialog({ mode: "add" })}
            onEdit={startEdit}
            onRemove={(name) => void remove(name)}
          />
          <DbAddMenu onAddManual={() => setDialog({ mode: "add" })} onAddWithAi={addWithAi} />
        </div>
      </header>

      <div className="min-h-0 flex-1">
        {error ? (
          <div className="p-4">
            <Alert variant="muted" className="border-destructive/40 text-destructive">
              {error}
            </Alert>
          </div>
        ) : selected ? (
          mode === "query" ? (
            <SqlConsole
              key={selected}
              connection={selected}
              engine={connections.find((c) => c.name === selected)?.engine}
              unlocked={
                connections.find((c) => c.name === selected)?.writeUnlocked ?? false
              }
              seed={seed}
              onWriteAccessChange={refresh}
              preferences={databasePreferences}
            />
          ) : (
            <ConnectionBrowser
              connection={selected}
              resultLimit={databasePreferences.resultLimit}
            />
          )
        ) : (
          <EmptyState onAdd={() => setDialog({ mode: "add" })} onAddWithAi={addWithAi} />
        )}
      </div>

      {dialog ? (
        <AddConnectionDialog
          initial={dialog.mode === "edit" ? dialog.target : undefined}
          projects={projects}
          onClose={() => setDialog(null)}
          onSaved={refresh}
        />
      ) : null}
    </div>
  );
}

function ViewModeToggle({
  mode,
  onChange,
}: {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
}) {
  const options: Array<{ value: ViewMode; label: string; icon: typeof Table2 }> = [
    { value: "browse", label: "Browse", icon: Table2 },
    { value: "query", label: "SQL", icon: Terminal },
  ];
  return (
    <div className="flex items-center rounded-md border border-border p-0.5">
      {options.map((option) => {
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={cn(
              "flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors",
              mode === option.value
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function ConnectionBrowser({ connection, resultLimit }: { connection: string; resultLimit: number }) {
  const { sendToAgent } = useAgentDock();
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
  } = useTableBrowser(connection, resultLimit);

  // Prefill the dock input with the table's schema so the user can ask away.
  function askTable(table: RowSample) {
    sendToAgent({
      prompt: buildTablePrompt(connection, table.table, {
        engine: table.engine,
        columns: table.columns,
      }),
      source: { type: "database-table", label: `${table.table.name} table` },
      mode: "draft",
    });
  }

  // Sidebar version: we only know the table name here, so the agent inspects it.
  function askTableByName(table: TableRef) {
    sendToAgent({
      prompt: buildTablePrompt(connection, table),
      source: { type: "database-table", label: `${table.name} table` },
      mode: "draft",
    });
  }

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
              <li
                key={table.qualifiedName}
                className={cn(
                  "group flex items-center gap-1 pr-1 transition-colors hover:bg-muted/50",
                  table.qualifiedName === selectedTable && "bg-muted/70",
                )}
              >
                <button
                  type="button"
                  onClick={() => setSelectedTable(table.qualifiedName)}
                  className={cn(
                    "min-w-0 flex-1 truncate px-3 py-1.5 text-left font-mono text-[11px]",
                    table.qualifiedName === selectedTable && "font-semibold",
                  )}
                >
                  {table.qualifiedName}
                </button>
                <AiSpark
                  label={`Ask AI about \`${table.qualifiedName}\``}
                  onAsk={() => askTableByName(table)}
                />
              </li>
            ))}
            {!loadingTables && tables.length === 0 ? (
              <li className="px-3 py-2 text-xs text-muted-foreground">No tables.</li>
            ) : null}
          </ul>
        )}
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="group flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate font-mono text-xs font-semibold">
              {selectedTable ?? "Select a table"}
            </span>
            {sample ? (
              <AiSpark
                label={`Ask AI about \`${sample.table.qualifiedName}\``}
                onAsk={() => askTable(sample)}
              />
            ) : null}
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
                {databaseLimitOptions(resultLimit).map((size) => (
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

function EmptyState({ onAdd, onAddWithAi }: { onAdd: () => void; onAddWithAi: () => void }) {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center">
      <div className="max-w-sm">
        <Database className="mx-auto size-8 text-muted-foreground/50" />
        <p className="mt-3 text-sm font-medium">No connections yet</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Add a read-only Postgres, MySQL, or SQLite connection to browse tables and sample rows.
          NoMoreIDE can auto-detect connection strings from your services' <code>.env</code> files.
        </p>
        <div className="mt-4 flex items-center justify-center gap-2">
          <Button size="sm" onClick={onAdd} type="button">
            <Plus />
            Add connection
          </Button>
          <Button size="sm" variant="outline" onClick={onAddWithAi} type="button">
            <Sparkles />
            Add with AI
          </Button>
        </div>
      </div>
    </div>
  );
}
