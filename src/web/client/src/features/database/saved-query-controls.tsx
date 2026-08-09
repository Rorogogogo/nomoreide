import { useEffect, useMemo, useRef, useState } from "react";
import { Bookmark, ChevronDown, Plus, Save, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToasts } from "@/components/ui/toast";
import { ComposerDialog } from "@/features/services/service-form/composer-dialog";
import { useT } from "@/lib/i18n";
import { usePersistentState } from "@/lib/use-persistent-state";
import { cn } from "@/lib/utils";

interface SavedDatabaseQuery {
  connection: string;
  id: string;
  name: string;
  sql: string;
  updatedAt: number;
}

interface OpenQueryTab {
  id: string;
  savedQueryId: string | null;
  sql: string;
}

interface QueryWorkspace {
  activeId: string;
  tabs: OpenQueryTab[];
}

export function SqlQueryTabs({
  connection,
  setSql,
  sql,
}: {
  connection: string;
  setSql: React.Dispatch<React.SetStateAction<string>>;
  sql: string;
}) {
  const t = useT();
  const { success: showSuccess } = useToasts();
  const fallbackIdRef = useRef(createOpenQueryId());
  const libraryRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const fallbackWorkspaceRef = useRef<QueryWorkspace>({
    activeId: fallbackIdRef.current,
    tabs: [{ id: fallbackIdRef.current, savedQueryId: null, sql }],
  });
  const fallbackWorkspace = fallbackWorkspaceRef.current;
  const [storedWorkspace, setWorkspace] = usePersistentState<QueryWorkspace>(
    `database:sql-tabs:v1:${connection}`,
    fallbackWorkspace,
  );
  const [storedSavedQueries, setSavedQueries] = usePersistentState<SavedDatabaseQuery[]>(
    "database:saved-queries:v1",
    [],
  );
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [showSaveAs, setShowSaveAs] = useState(false);
  const [closeAfterSaveId, setCloseAfterSaveId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SavedDatabaseQuery | null>(null);
  const [pendingClose, setPendingClose] = useState<OpenQueryTab | null>(null);
  const workspace = normalizeWorkspace(storedWorkspace, fallbackWorkspace);
  const activeTab = workspace.tabs.find((tab) => tab.id === workspace.activeId)
    ?? workspace.tabs[0];
  const savedQueries = useMemo(
    () => normalizeSavedQueries(storedSavedQueries),
    [storedSavedQueries],
  );
  const connectionQueries = useMemo(
    () => savedQueries
      .filter((query) => query.connection === connection)
      .toSorted((left, right) => right.updatedAt - left.updatedAt),
    [connection, savedQueries],
  );
  const visibleQueries = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    if (!needle) return connectionQueries;
    return connectionQueries.filter((query) =>
      query.name.toLocaleLowerCase().includes(needle)
      || query.sql.toLocaleLowerCase().includes(needle)
    );
  }, [connectionQueries, search]);
  const activeQuery = activeTab
    ? connectionQueries.find((query) => query.id === activeTab.savedQueryId) ?? null
    : null;

  useEffect(() => {
    if (!activeTab || activeTab.sql === sql) return;
    setWorkspace((current) => {
      const normalized = normalizeWorkspace(current, fallbackWorkspace);
      return {
        ...normalized,
        tabs: normalized.tabs.map((tab) =>
          tab.id === normalized.activeId ? { ...tab, sql } : tab
        ),
      };
    });
  }, [activeTab, fallbackWorkspace, setWorkspace, sql]);

  useEffect(() => {
    if (!libraryOpen) return;
    searchInputRef.current?.focus();
    function closeLibrary(event: PointerEvent) {
      if (!libraryRef.current?.contains(event.target as Node)) setLibraryOpen(false);
    }
    document.addEventListener("pointerdown", closeLibrary);
    return () => document.removeEventListener("pointerdown", closeLibrary);
  }, [libraryOpen]);

  function activateTab(tab: OpenQueryTab) {
    if (tab.id === activeTab?.id) return;
    setWorkspace((current) => ({
      ...normalizeWorkspace(current, fallbackWorkspace),
      activeId: tab.id,
    }));
    setSql(tab.sql);
  }

  function addTab() {
    const tab: OpenQueryTab = { id: createOpenQueryId(), savedQueryId: null, sql: "" };
    setWorkspace((current) => {
      const normalized = normalizeWorkspace(current, fallbackWorkspace);
      return { activeId: tab.id, tabs: [...normalized.tabs, tab] };
    });
    setSql("");
  }

  function openSavedQuery(query: SavedDatabaseQuery) {
    const open = workspace.tabs.find((tab) => tab.savedQueryId === query.id);
    if (open) {
      activateTab(open);
    } else if (activeTab && activeTab.savedQueryId === null && activeTab.sql === query.sql) {
      setWorkspace((current) => {
        const normalized = normalizeWorkspace(current, fallbackWorkspace);
        return {
          ...normalized,
          tabs: normalized.tabs.map((tab) =>
            tab.id === normalized.activeId ? { ...tab, savedQueryId: query.id } : tab
          ),
        };
      });
    } else {
      const tab: OpenQueryTab = {
        id: createOpenQueryId(),
        savedQueryId: query.id,
        sql: query.sql,
      };
      setWorkspace((current) => {
        const normalized = normalizeWorkspace(current, fallbackWorkspace);
        return { activeId: tab.id, tabs: [...normalized.tabs, tab] };
      });
      setSql(query.sql);
    }
    setLibraryOpen(false);
    setSearch("");
  }

  function tabIsDirty(tab: OpenQueryTab): boolean {
    const saved = connectionQueries.find((query) => query.id === tab.savedQueryId);
    return saved ? tab.sql !== saved.sql : tab.sql.trim().length > 0;
  }

  function requestClose(tab: OpenQueryTab) {
    if (tabIsDirty(tab)) {
      activateTab(tab);
      setPendingClose(tab);
    }
    else closeTab(tab.id);
  }

  function closeTab(id: string) {
    const index = workspace.tabs.findIndex((tab) => tab.id === id);
    const remaining = workspace.tabs.filter((tab) => tab.id !== id);
    if (remaining.length === 0) {
      const replacement: OpenQueryTab = {
        id: createOpenQueryId(),
        savedQueryId: null,
        sql: "",
      };
      setWorkspace({ activeId: replacement.id, tabs: [replacement] });
      setSql("");
    } else {
      const next = workspace.activeId === id
        ? remaining[Math.max(0, index - 1)] ?? remaining[0]
        : activeTab;
      setWorkspace({
        activeId: next?.id ?? remaining[0].id,
        tabs: remaining,
      });
      if (workspace.activeId === id) setSql(next?.sql ?? "");
    }
    setPendingClose(null);
  }

  function saveExisting() {
    if (!activeTab || !activeQuery) {
      setShowSaveAs(true);
      return;
    }
    const updatedAt = Date.now();
    setSavedQueries((current) => normalizeSavedQueries(current).map((query) =>
      query.id === activeQuery.id ? { ...query, sql, updatedAt } : query
    ));
    showSuccess(t("database.sql.savedQueryUpdated", { name: activeQuery.name }));
  }

  function saveAs(name: string) {
    if (!activeTab) return;
    const query: SavedDatabaseQuery = {
      connection,
      id: createSavedQueryId(),
      name,
      sql,
      updatedAt: Date.now(),
    };
    setSavedQueries((current) => [...normalizeSavedQueries(current), query]);
    setWorkspace((current) => {
      const normalized = normalizeWorkspace(current, fallbackWorkspace);
      return {
        ...normalized,
        tabs: normalized.tabs.map((tab) =>
          tab.id === normalized.activeId ? { ...tab, savedQueryId: query.id, sql } : tab
        ),
      };
    });
    setShowSaveAs(false);
    showSuccess(t("database.sql.savedQueryCreated", { name }));
    if (closeAfterSaveId) {
      closeTab(closeAfterSaveId);
      setCloseAfterSaveId(null);
    }
  }

  function savePendingAndClose() {
    if (!pendingClose) return;
    if (!activeQuery) {
      setCloseAfterSaveId(pendingClose.id);
      setPendingClose(null);
      setShowSaveAs(true);
      return;
    }
    const closingId = pendingClose.id;
    const updatedAt = Date.now();
    setSavedQueries((current) => normalizeSavedQueries(current).map((query) =>
      query.id === activeQuery.id ? { ...query, sql, updatedAt } : query
    ));
    showSuccess(t("database.sql.savedQueryUpdated", { name: activeQuery.name }));
    closeTab(closingId);
  }

  function deleteQuery() {
    if (!pendingDelete) return;
    setSavedQueries((current) =>
      normalizeSavedQueries(current).filter((query) => query.id !== pendingDelete.id)
    );
    setWorkspace((current) => {
      const normalized = normalizeWorkspace(current, fallbackWorkspace);
      return {
        ...normalized,
        tabs: normalized.tabs.map((tab) =>
          tab.savedQueryId === pendingDelete.id ? { ...tab, savedQueryId: null } : tab
        ),
      };
    });
    showSuccess(t("database.sql.savedQueryDeleted", { name: pendingDelete.name }));
    setPendingDelete(null);
  }

  return (
    <>
      <div className="flex min-w-0 shrink-0 items-center border-b border-border bg-background">
        <div className="min-w-0 flex-1 overflow-x-auto px-1.5 py-1">
          <div
            aria-label={t("database.sql.openQueries")}
            className="flex min-w-max items-center gap-1"
            role="tablist"
          >
            {workspace.tabs.map((tab, index) => {
              const saved = connectionQueries.find((query) => query.id === tab.savedQueryId);
              const active = tab.id === activeTab?.id;
              const dirty = tabIsDirty(tab);
              const label = saved?.name ?? t("database.sql.untitledQueryNumber", { number: index + 1 });
              return (
                <div
                  className={cn(
                    "group flex h-7 max-w-44 shrink-0 items-center rounded text-[11px] font-medium focus-within:ring-2 focus-within:ring-ring",
                    active
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:bg-muted/20 hover:text-foreground",
                  )}
                  key={tab.id}
                >
                  <button
                    aria-label={dirty ? `${label}, ${t("database.sql.unsavedChanges")}` : label}
                    aria-selected={active}
                    className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-2 outline-none"
                    onClick={() => activateTab(tab)}
                    role="tab"
                    title={label}
                    type="button"
                  >
                    {dirty ? (
                      <span
                        aria-hidden="true"
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          active ? "bg-background" : "bg-amber-500",
                        )}
                      />
                    ) : null}
                    <span className="truncate">{label}</span>
                  </button>
                  <button
                    aria-label={t("database.sql.closeQuery", { name: label })}
                    className="mr-0.5 rounded p-1 opacity-60 outline-none hover:bg-background/15 hover:opacity-100"
                    onClick={() => requestClose(tab)}
                    title={t("database.sql.closeQuery", { name: label })}
                    type="button"
                  >
                    <X aria-hidden="true" className="size-3" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="relative flex shrink-0 items-center gap-0.5 border-l border-border px-1.5" ref={libraryRef}>
          <Button
            aria-label={t("database.sql.newQuery")}
            className="text-muted-foreground"
            onClick={addTab}
            size="icon-sm"
            title={t("database.sql.newQuery")}
            type="button"
            variant="ghost"
          >
            <Plus />
          </Button>
          <Button
            aria-expanded={libraryOpen}
            className="h-7 gap-1 px-2 text-[11px]"
            onClick={() => setLibraryOpen((open) => !open)}
            size="sm"
            type="button"
            variant="ghost"
          >
            <Bookmark />
            <span className="max-sm:hidden">{t("database.sql.savedQueries")}</span>
            <ChevronDown aria-hidden="true" className="size-3" />
          </Button>
          <Button
            aria-label={activeQuery ? t("common.save") : t("database.sql.saveQueryAs")}
            className="h-7 px-2 text-[11px]"
            disabled={!sql.trim()}
            onClick={saveExisting}
            size="sm"
            title={activeQuery ? t("common.save") : t("database.sql.saveQueryAs")}
            type="button"
            variant="ghost"
          >
            <Save />
            <span className="max-md:hidden">{t("common.save")}</span>
          </Button>
          {activeQuery ? (
            <Button
              aria-label={t("database.sql.deleteSavedQuery")}
              className="text-muted-foreground hover:text-destructive"
              onClick={() => setPendingDelete(activeQuery)}
              size="icon-sm"
              title={t("database.sql.deleteSavedQuery")}
              type="button"
              variant="ghost"
            >
              <Trash2 />
            </Button>
          ) : null}

          {libraryOpen ? (
            <div className="absolute right-1 top-[calc(100%+0.25rem)] z-50 w-72 max-w-[calc(100vw-1rem)] rounded-md border border-border bg-popover p-1.5 text-popover-foreground shadow-md">
              <input
                aria-label={t("database.sql.searchSavedQueries")}
                className="h-8 w-full rounded border border-border bg-background px-2 text-[11px] outline-none focus:border-ring"
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("database.sql.searchSavedQueries")}
                ref={searchInputRef}
                value={search}
              />
              <div className="mt-1 max-h-56 overflow-auto">
                {visibleQueries.length > 0 ? visibleQueries.map((query) => (
                  <button
                    className="flex w-full min-w-0 flex-col rounded px-2 py-1.5 text-left hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    key={query.id}
                    onClick={() => openSavedQuery(query)}
                    type="button"
                  >
                    <span className="w-full truncate text-[11px] font-medium">{query.name}</span>
                    <span className="w-full truncate font-mono text-[9px] text-muted-foreground">
                      {query.sql}
                    </span>
                  </button>
                )) : (
                  <p className="px-2 py-4 text-center text-[11px] text-muted-foreground">
                    {t("database.sql.noSavedQueries")}
                  </p>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {showSaveAs ? (
        <SaveQueryDialog
          defaultName={defaultSavedQueryName(sql, t("database.sql.untitledQuery"))}
          onClose={() => {
            setShowSaveAs(false);
            setCloseAfterSaveId(null);
          }}
          onSave={saveAs}
        />
      ) : null}
      {pendingDelete ? (
        <ConfirmDialog
          cancelLabel={t("common.cancel")}
          confirmLabel={t("common.delete")}
          icon={<Trash2 className="text-destructive" />}
          message={t("database.sql.deleteSavedQueryBody", { name: pendingDelete.name })}
          onCancel={() => setPendingDelete(null)}
          onConfirm={deleteQuery}
          title={t("database.sql.deleteSavedQueryTitle")}
          tone="danger"
        />
      ) : null}
      {pendingClose ? (
        <UnsavedQueryDialog
          onCancel={() => setPendingClose(null)}
          onDiscard={() => closeTab(pendingClose.id)}
          onSave={savePendingAndClose}
        />
      ) : null}
    </>
  );
}

function UnsavedQueryDialog({
  onCancel,
  onDiscard,
  onSave,
}: {
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const t = useT();
  return (
    <ComposerDialog
      icon={<X className="text-destructive" />}
      onClose={onCancel}
      title={t("database.sql.closeUnsavedQueryTitle")}
    >
      <p className="text-sm text-muted-foreground">{t("database.sql.closeUnsavedQueryBody")}</p>
      <div className="mt-4 flex justify-end gap-2 border-t border-border pt-3">
        <Button onClick={onCancel} size="sm" type="button" variant="outline">
          {t("common.cancel")}
        </Button>
        <Button onClick={onDiscard} size="sm" type="button" variant="destructive">
          {t("database.sql.discardChanges")}
        </Button>
        <Button onClick={onSave} size="sm" type="button">
          <Save />
          {t("common.save")}
        </Button>
      </div>
    </ComposerDialog>
  );
}

function SaveQueryDialog({
  defaultName,
  onClose,
  onSave,
}: {
  defaultName: string;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const t = useT();
  const [name, setName] = useState(defaultName);
  const trimmedName = name.trim();

  return (
    <ComposerDialog
      icon={<Bookmark />}
      onClose={onClose}
      title={t("database.sql.saveQueryTitle")}
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmedName) onSave(trimmedName);
        }}
      >
        <label className="block space-y-1.5 text-xs font-medium">
          <span>{t("database.sql.queryName")}</span>
          <input
            className="h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm outline-none focus:border-ring"
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("database.sql.queryNamePlaceholder")}
            value={name}
          />
        </label>
        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            {t("common.cancel")}
          </Button>
          <Button disabled={!trimmedName} size="sm" type="submit">
            <Save />
            {t("database.sql.saveQuery")}
          </Button>
        </div>
      </form>
    </ComposerDialog>
  );
}

function createOpenQueryId(): string {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createSavedQueryId(): string {
  return `query-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultSavedQueryName(sql: string, fallback: string): string {
  const firstLine = sql.trim().split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ") ?? "";
  return firstLine.slice(0, 60) || fallback;
}

function normalizeWorkspace(value: unknown, fallback: QueryWorkspace): QueryWorkspace {
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as Partial<QueryWorkspace>;
  if (!Array.isArray(candidate.tabs)) return fallback;
  const tabs = candidate.tabs.filter((tab): tab is OpenQueryTab => {
    if (!tab || typeof tab !== "object") return false;
    const entry = tab as Partial<OpenQueryTab>;
    return typeof entry.id === "string"
      && (entry.savedQueryId === null || typeof entry.savedQueryId === "string")
      && typeof entry.sql === "string";
  });
  if (tabs.length === 0) return fallback;
  const activeId = typeof candidate.activeId === "string"
    && tabs.some((tab) => tab.id === candidate.activeId)
    ? candidate.activeId
    : tabs[0].id;
  return { activeId, tabs };
}

function normalizeSavedQueries(value: unknown): SavedDatabaseQuery[] {
  if (!Array.isArray(value)) return [];
  return value.filter((query): query is SavedDatabaseQuery => {
    if (!query || typeof query !== "object") return false;
    const candidate = query as Partial<SavedDatabaseQuery>;
    return typeof candidate.connection === "string"
      && typeof candidate.id === "string"
      && typeof candidate.name === "string"
      && typeof candidate.sql === "string"
      && typeof candidate.updatedAt === "number";
  });
}
