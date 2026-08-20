import { useCallback, useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useSettings } from "@/features/settings/settings-context";
import {
  createTerminalSession,
  closeTerminalSession,
  listTerminalSessions,
  type TerminalSessionInfo,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { TerminalPane } from "./terminal-pane";

/**
 * The Terminal page: a tab strip over one {@link TerminalPane} per server
 * session. Tabs are server-persisted, so reloading the browser re-attaches to
 * every shell that is still running.
 */
export function TerminalView() {
  const t = useT();
  const { confirmedGlobal } = useSettings();
  const [tabs, setTabs] = useState<TerminalSessionInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingClose, setPendingClose] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let sessions = await listTerminalSessions().catch(() => []);
      if (sessions.length === 0) {
        const created = await createTerminalSession().catch(() => null);
        sessions = created ? [created] : [];
      }
      if (cancelled) return;
      setTabs(sessions);
      setActiveId(sessions[0]?.id ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const addTab = useCallback(async () => {
    setBusy(true);
    try {
      const created = await createTerminalSession();
      setTabs((prev) => [...prev, created]);
      setActiveId(created.id);
    } finally {
      setBusy(false);
    }
  }, []);

  const closeTab = useCallback(
    async (id: string) => {
      setBusy(true);
      try {
        await closeTerminalSession(id);
        const index = tabs.findIndex((tab) => tab.id === id);
        const remaining = tabs.filter((tab) => tab.id !== id);
        if (remaining.length === 0) {
          const created = await createTerminalSession();
          setTabs([created]);
          setActiveId(created.id);
          return;
        }
        setTabs(remaining);
        if (activeId === id) {
          const next = remaining[Math.min(index, remaining.length - 1)];
          setActiveId(next.id);
        }
      } finally {
        setBusy(false);
      }
    },
    [tabs, activeId],
  );

  const requestClose = useCallback(
    (id: string, name: string) => {
      if (confirmedGlobal.terminal.confirmTerminate) {
        setPendingClose({ id, name });
        return;
      }
      void closeTab(id);
    },
    [closeTab, confirmedGlobal.terminal.confirmTerminate],
  );

  return (
    <section className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div
        aria-label={t("terminal.tabs")}
        className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-card px-2 py-1.5"
        role="tablist"
      >
        {tabs.map((tab, index) => {
          const name = tab.label ?? t("terminal.tabName", { n: index + 1 });
          return (
          <div
            key={tab.id}
            className={cn(
              "group flex items-center gap-1 rounded-md border border-transparent px-2 py-1 text-xs",
              tab.id === activeId
                ? "border-border bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            <button
              aria-selected={tab.id === activeId}
              className="max-w-[160px] truncate font-medium"
              onClick={() => setActiveId(tab.id)}
              role="tab"
              type="button"
            >
              {name}
            </button>
            <button
              aria-label={t("terminal.closeTab", { name })}
              className="rounded p-0.5 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100"
              disabled={busy}
              onClick={() => requestClose(tab.id, name)}
              type="button"
            >
              <X className="size-3" />
            </button>
          </div>
          );
        })}
        <button
          aria-label={t("terminal.newTerminal")}
          className="ml-1 rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40"
          disabled={busy}
          onClick={() => void addTab()}
          type="button"
        >
          <Plus className="size-4" />
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        {tabs.length === 0 ? (
          <div className="flex h-full items-center justify-center font-mono text-[11px] text-muted-foreground">
            {t("terminal.starting")}
          </div>
        ) : (
          tabs.map((tab) => (
            <div key={tab.id} className="absolute inset-0">
              <TerminalPane active={tab.id === activeId} sessionId={tab.id} />
            </div>
          ))
        )}
      </div>
      {pendingClose ? (
        <ConfirmDialog
          confirmLabel={`Close ${pendingClose.name}`}
          loading={busy}
          message="The running shell process will be terminated and this terminal tab will be closed."
          onCancel={() => setPendingClose(null)}
          onConfirm={() => {
            const id = pendingClose.id;
            setPendingClose(null);
            void closeTab(id);
          }}
          title={`Close ${pendingClose.name}?`}
          tone="danger"
        />
      ) : null}
    </section>
  );
}
