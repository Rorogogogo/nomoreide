import { useEffect, useMemo, useRef, useState } from "react";
import {
  Database,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Sparkles,
  Table2,
  Terminal,
} from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Loading } from "@/components/ui/loading";
import { Tooltip } from "@/components/ui/tooltip";
import { useToasts } from "@/components/ui/toast";
import { useRegisterRefresh } from "@/components/refresh-registry";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { usePersistentState } from "@/lib/use-persistent-state";
import { useOptionalSettings } from "@/features/settings/settings-context";
import {
  deleteDatabase,
  type DatabaseConnection,
  type GitRepositoryDefinition,
} from "@/lib/api";
import { connectionInScope } from "../services/project-scope";
import { useAgentDock } from "../agent/chat/agent-context";
import { DATABASE_SETUP_PROMPT } from "../agent/prompts";
import { AddConnectionDialog, type EditTarget } from "./add-connection-dialog";
import {
  DatabaseExplorer,
  type SelectedCatalogObject,
} from "./database-explorer";
import { SqlConsole, type SqlEditorAction } from "./sql-console";
import { useDatabases } from "./use-databases";

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
  const t = useT();
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
  useRegisterRefresh(refresh);
  const { error: showError, success: showSuccess } = useToasts();
  const { sendToAgent } = useAgentDock();
  // Sticky so returning to Database keeps your connection and Browse/SQL choice.
  const [selected, setSelected] = usePersistentState<string | null>(
    "database:selected",
    null,
  );
  const [mode, setMode] = usePersistentState<ViewMode>("database:mode", "browse");
  const [selectedCatalogObject, setSelectedCatalogObject] =
    usePersistentState<SelectedCatalogObject | null>("database:selected-object", null);
  const [sqlExplorerOpen, setSqlExplorerOpen] = usePersistentState(
    "database:sql-explorer-open",
    true,
  );
  const [sqlMounted, setSqlMounted] = useState(mode === "query");
  const [editorAction, setEditorAction] = useState<SqlEditorAction | null>(null);
  const editorActionNonce = useRef(0);
  const [dialog, setDialog] = useState<Dialog>(null);
  // One-shot seed handed to the SQL console when a write is staged from the dock.
  const [seed, setSeed] = useState<{ sql: string; nonce: number } | null>(null);

  // A staged write from the dock: jump to its connection, flip to the SQL tab,
  // and hand the statement to the console. Consume it so a later revisit is
  // clean — the user's edits in the editor then stand on their own.
  useEffect(() => {
    if (!staged) return;
    if (staged.connection) setSelected(staged.connection);
    setSqlMounted(true);
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
      showSuccess(t("database.toast.removed", { name }));
      await refresh();
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function startEdit(connection: DatabaseConnection) {
    setDialog({ mode: "edit", target: connection });
  }

  function changeMode(nextMode: ViewMode) {
    if (nextMode === "query") setSqlMounted(true);
    setMode(nextMode);
  }

  function openObjectInBrowse(selection: SelectedCatalogObject) {
    setSelected(selection.connection);
    setSelectedCatalogObject(selection);
    setMode("browse");
  }

  function sendObjectToEditor(
    selection: SelectedCatalogObject,
    sql: string,
    mode: SqlEditorAction["mode"],
  ) {
    editorActionNonce.current += 1;
    setSelected(selection.connection);
    setSelectedCatalogObject(selection);
    setSqlMounted(true);
    setMode("query");
    setEditorAction({
      connection: selection.connection,
      mode,
      nonce: editorActionNonce.current,
      sql,
    });
  }

  const selectedConnection = connections.find((connection) => connection.name === selected);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Database aria-hidden="true" className="size-4 text-muted-foreground" />
          <span className="shrink-0 text-sm font-semibold">{t("database.title")}</span>
          {selectedConnection ? (
            <>
              <span aria-hidden="true" className="text-muted-foreground/50">/</span>
              <code
                className="min-w-0 truncate font-mono text-[11px] font-medium"
                title={selectedConnection.name}
              >
                {selectedConnection.name}
              </code>
              <span className="shrink-0 text-[9px] uppercase tracking-wide text-muted-foreground">
                {selectedConnection.engine}
              </span>
            </>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center gap-2">
          {selected && mode === "query" ? (
            <Tooltip
              align="end"
              label={t(
                sqlExplorerOpen
                  ? "database.sql.hideExplorer"
                  : "database.sql.showExplorer",
              )}
            >
              <Button
                aria-label={t(
                  sqlExplorerOpen
                    ? "database.sql.hideExplorer"
                    : "database.sql.showExplorer",
                )}
                className="text-muted-foreground"
                onClick={() => setSqlExplorerOpen((open) => !open)}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                {sqlExplorerOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
              </Button>
            </Tooltip>
          ) : null}
          {selected ? <ViewModeToggle mode={mode} onChange={changeMode} /> : null}
        </div>
      </header>

      <div className="min-h-0 flex-1">
        {loading && connections.length === 0 ? (
          <Loading fill label={t("common.loading")} />
        ) : error ? (
          <div className="p-4">
            <Alert variant="muted" className="border-destructive/40 text-destructive">
              {error}
            </Alert>
          </div>
        ) : selected ? (
          <>
            <div
              className={cn(
                "h-full min-h-0 overflow-hidden",
                mode === "query"
                  ? sqlExplorerOpen
                    ? "grid grid-cols-[minmax(12rem,18rem)_minmax(0,1fr)] max-sm:grid-cols-[minmax(9rem,44vw)_minmax(0,1fr)]"
                    : "grid grid-cols-1"
                  : "hidden",
              )}
              data-database-workspace="sql"
            >
              {sqlMounted && sqlExplorerOpen ? (
                <DatabaseExplorer
                  connections={connections}
                  onAddConnection={() => setDialog({ mode: "add" })}
                  onAddWithAi={addWithAi}
                  onEditConnection={startEdit}
                  onRemoveConnection={(name) => void remove(name)}
                  onGenerateObjectSelect={(selection) =>
                    sendObjectToEditor(
                      selection,
                      `SELECT * FROM ${selection.object.qualifiedName} LIMIT ${databasePreferences.resultLimit};`,
                      "statement",
                    )
                  }
                  onInsertObjectName={(selection) =>
                    sendObjectToEditor(selection, selection.object.qualifiedName, "insert")
                  }
                  onOpenObjectInBrowse={openObjectInBrowse}
                  onSelectConnection={setSelected}
                  onSelectedCatalogObjectChange={setSelectedCatalogObject}
                  resultLimit={databasePreferences.resultLimit}
                  selectedCatalogObject={selectedCatalogObject}
                  selectedConnection={selected}
                  sidebarOnly
                  surface="sql"
                />
              ) : null}
              {sqlMounted ? (
                <SqlConsole
                  key={selected}
                  connection={selected}
                  editorAction={editorAction}
                  engine={selectedConnection?.engine}
                  unlocked={
                    selectedConnection?.writeUnlocked ?? false
                  }
                  seed={seed}
                  onWriteAccessChange={refresh}
                  preferences={databasePreferences}
                />
              ) : null}
            </div>
            <div
              className={cn("h-full min-h-0", mode !== "browse" && "hidden")}
              data-database-workspace="browse"
            >
              <DatabaseExplorer
                connections={connections}
                onAddConnection={() => setDialog({ mode: "add" })}
                onAddWithAi={addWithAi}
                onEditConnection={startEdit}
                onRemoveConnection={(name) => void remove(name)}
                onSelectConnection={setSelected}
                onSelectedCatalogObjectChange={setSelectedCatalogObject}
                onWriteAccessChange={refresh}
                resultLimit={databasePreferences.resultLimit}
                selectedCatalogObject={selectedCatalogObject}
                selectedConnection={selected}
              />
            </div>
          </>
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
  const t = useT();
  const options: Array<{ value: ViewMode; label: string; icon: typeof Table2 }> = [
    { value: "browse", label: t("database.browse"), icon: Table2 },
    { value: "query", label: t("database.sql"), icon: Terminal },
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
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon aria-hidden="true" className="size-3.5" />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function EmptyState({ onAdd, onAddWithAi }: { onAdd: () => void; onAddWithAi: () => void }) {
  const t = useT();
  return (
    <div className="flex h-full items-center justify-center p-8 text-center">
      <div className="max-w-sm">
        <Database className="mx-auto size-8 text-muted-foreground/50" />
        <p className="mt-3 text-sm font-medium">{t("database.emptyTitle")}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("database.emptyBody1")} <code>.env</code> {t("database.emptyBody2")}
        </p>
        <div className="mt-4 flex items-center justify-center gap-2">
          <Button size="sm" onClick={onAdd} type="button">
            <Plus />
            {t("database.addConnection")}
          </Button>
          <Button size="sm" variant="outline" onClick={onAddWithAi} type="button">
            <Sparkles />
            {t("database.addWithAi")}
          </Button>
        </div>
      </div>
    </div>
  );
}
