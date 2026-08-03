import { useEffect, useMemo, useState } from "react";
import { Database, Loader2, Plus, Sparkles, Table2, Terminal } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import { DatabaseExplorer } from "./database-explorer";
import { SqlConsole } from "./sql-console";
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
      showSuccess(t("database.toast.removed", { name }));
      await refresh();
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function startEdit(connection: DatabaseConnection) {
    setDialog({ mode: "edit", target: connection });
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <Database aria-hidden="true" className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold">{t("database.title")}</span>
          {loading && connections.length === 0 ? (
            <Loader2 aria-hidden="true" className="size-3.5 animate-spin text-muted-foreground motion-reduce:animate-none" />
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {selected ? <ViewModeToggle mode={mode} onChange={setMode} /> : null}
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
            <DatabaseExplorer
              connections={connections}
              onAddConnection={() => setDialog({ mode: "add" })}
              onAddWithAi={addWithAi}
              onEditConnection={startEdit}
              onRemoveConnection={(name) => void remove(name)}
              onSelectConnection={setSelected}
              onWriteAccessChange={refresh}
              resultLimit={databasePreferences.resultLimit}
              selectedConnection={selected}
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
