import { useEffect, useMemo, useRef, useState } from "react";
import { Bookmark, ChevronDown, Plus, Save, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToasts } from "@/components/ui/toast";
import { useT } from "@/lib/i18n";
import { usePersistentState } from "@/lib/use-persistent-state";
import { cn } from "@/lib/utils";
import { SaveQueryDialog, UnsavedQueryDialog } from "./query-dialogs";
import {
  createOpenQueryId,
  createSavedQueryId,
  defaultSavedQueryName,
  normalizeSavedQueries,
  normalizeWorkspace,
} from "./query-storage";
import type {
  OpenQueryTab,
  QueryWorkspace,
  SavedDatabaseQuery,
} from "./query-types";

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
