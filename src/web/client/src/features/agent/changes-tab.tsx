import { useCallback, useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  getChangeSet,
  getChangeSetDiff,
  listChangeSets,
  restoreChangeSet,
  type AgentChangeSession,
  type SnapshotChange,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { ChangedFilesWithDiff } from "../git/snapshots/snapshots-view";

/**
 * "What did the AI touch": each agent session is pinned to the snapshot taken
 * before its first tool call; the change-set is the diff between that
 * snapshot and the working tree as it is now.
 */
export function ChangesTab() {
  const [sessions, setSessions] = useState<AgentChangeSession[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await listChangeSets();
      setSessions(next);
      setSelectedId((current) =>
        current && next.some((session) => session.id === current)
          ? current
          : (next[0]?.id ?? ""),
      );
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleRestore(id: string) {
    setBusy(true);
    setNotice(null);
    try {
      const result = await restoreChangeSet(id);
      await refresh();
      setNotice(
        `Restored ${result.restoredFiles} file(s)` +
          (result.deletedPaths.length
            ? `, removed ${result.deletedPaths.length} created by the session`
            : "") +
          `. Undo via pre-restore snapshot ${result.preRestore.sha.slice(0, 7)} in Git → Snapshots.`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  if (sessions.length === 0) {
    return (
      <div className="p-4">
        <Alert variant="muted" className="border-dashed p-8 text-center">
          {error ??
            "No agent sessions recorded yet. Sessions appear here once an agent calls a nomoreide MCP tool; each one starts with a working-tree snapshot you can roll back to."}
        </Alert>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {notice ? (
        <Alert variant="muted" className="m-3 mb-0">
          {notice}
        </Alert>
      ) : null}
      <div className="grid min-h-0 flex-1 xl:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="min-h-0 overflow-auto border-r border-border">
          <ul>
            {sessions.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(session.id)}
                  className={cn(
                    "w-full border-b border-border/60 px-3 py-2 text-left transition-colors",
                    session.id === selectedId ? "bg-background" : "hover:bg-muted/50",
                  )}
                >
                  <span className="block truncate text-xs font-medium">
                    {new Date(session.startedAt).toLocaleString()}
                  </span>
                  <span className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span>{session.toolCount} tool call(s)</span>
                    {session.snapshotSha ? (
                      <span className="font-mono">
                        {session.snapshotSha.slice(0, 7)}
                      </span>
                    ) : (
                      <span>no snapshot</span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
        <section className="flex min-h-0 min-w-0 flex-col">
          {selectedId ? (
            <ChangeSetDetail
              busy={busy}
              id={selectedId}
              onRestore={handleRestore}
            />
          ) : null}
        </section>
      </div>
    </div>
  );
}

function ChangeSetDetail({
  busy,
  id,
  onRestore,
}: {
  busy: boolean;
  id: string;
  onRestore: (id: string) => Promise<void>;
}) {
  const [session, setSession] = useState<AgentChangeSession | null>(null);
  const [files, setFiles] = useState<SnapshotChange[]>([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [diff, setDiff] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let active = true;
    setConfirming(false);
    setError(null);
    void getChangeSet(id)
      .then((next) => {
        if (!active) return;
        setSession(next.session);
        setFiles(next.files);
        setSelectedPath((current) =>
          current && next.files.some((file) => file.path === current)
            ? current
            : (next.files[0]?.path ?? ""),
        );
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      active = false;
    };
  }, [id]);

  useEffect(() => {
    if (!selectedPath) {
      setDiff("");
      return;
    }
    let active = true;
    void getChangeSetDiff(id, selectedPath)
      .then((next) => {
        if (active) setDiff(next);
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      active = false;
    };
  }, [id, selectedPath]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <h2 className="truncate text-[13px] font-semibold tracking-tight">
            {files.length
              ? `${files.length} file(s) changed since this session started`
              : "No working-tree changes since this session started"}
          </h2>
          <p className="truncate text-[10px] text-muted-foreground">
            {session?.repoPath ?? ""}
          </p>
        </div>
        {session?.snapshotSha ? (
          confirming ? (
            <span className="flex shrink-0 items-center gap-1.5">
              <Button
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                  void onRestore(id);
                }}
                size="sm"
                type="button"
                variant="destructive"
              >
                Confirm restore
              </Button>
              <Button
                onClick={() => setConfirming(false)}
                size="sm"
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
            </span>
          ) : (
            <Button
              disabled={busy || files.length === 0}
              onClick={() => setConfirming(true)}
              size="sm"
              title="Reset the working tree to before this session (a pre-restore snapshot is taken first)"
              type="button"
              variant="outline"
            >
              <RotateCcw className="size-3.5" />
              Restore to before this session…
            </Button>
          )
        ) : null}
      </div>
      <ChangedFilesWithDiff
        diff={diff}
        error={error}
        files={files}
        onSelectPath={setSelectedPath}
        selectedPath={selectedPath}
      />
    </div>
  );
}
