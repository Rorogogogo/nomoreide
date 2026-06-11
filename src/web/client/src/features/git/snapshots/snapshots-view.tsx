import { useCallback, useEffect, useState } from "react";
import { Camera, Check, CircleAlert, History, Pencil, RotateCcw, Trash2, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  createSnapshot,
  deleteSnapshot,
  getSnapshotDiff,
  getSnapshotFiles,
  listSnapshots,
  renameSnapshot,
  restoreSnapshot,
  type Snapshot,
  type SnapshotChange,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { DiffViewer } from "../diff-viewer";

/** Working-tree checkpoints: list, take, inspect, and (with confirm) restore. */
export function SnapshotsView() {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [selectedSha, setSelectedSha] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await listSnapshots();
      setSnapshots(next);
      setSelectedSha((current) =>
        current && next.some((snapshot) => snapshot.sha === current)
          ? current
          : (next[0]?.sha ?? ""),
      );
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function takeSnapshot() {
    setBusy(true);
    setNotice(null);
    try {
      const snapshot = await createSnapshot("manual snapshot");
      await refresh();
      setSelectedSha(snapshot.sha);
      setNotice(`Snapshot ${snapshot.sha.slice(0, 7)} created.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleRename(sha: string, label: string) {
    setBusy(true);
    setNotice(null);
    try {
      const renamed = await renameSnapshot(sha, label);
      await refresh();
      setSelectedSha(renamed.sha);
      setNotice(`Snapshot renamed to “${renamed.label}”.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(sha: string) {
    setBusy(true);
    setNotice(null);
    try {
      await deleteSnapshot(sha);
      await refresh();
      setNotice(`Snapshot ${sha.slice(0, 7)} deleted.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleRestore(sha: string) {
    setBusy(true);
    setNotice(null);
    try {
      const result = await restoreSnapshot(sha);
      await refresh();
      setNotice(
        `Restored ${result.restoredFiles} file(s)` +
          (result.deletedPaths.length
            ? `, removed ${result.deletedPaths.length} added since`
            : "") +
          `. Undo via pre-restore snapshot ${result.preRestore.sha.slice(0, 7)}.`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  const selected = snapshots.find((snapshot) => snapshot.sha === selectedSha);

  return (
    <div className="grid h-full min-h-0 overflow-hidden bg-card/85 xl:grid-cols-[320px_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col overflow-hidden border-r border-border">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
          <span className="flex items-center gap-1.5 text-xs font-semibold">
            <History className="size-3.5" />
            Snapshots
          </span>
          <Button disabled={busy} onClick={() => void takeSnapshot()} size="sm" type="button">
            <Camera className="size-3.5" />
            Snapshot now
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {error ? (
            <Alert variant="destructive" className="m-3">
              <CircleAlert />
              <div className="min-w-0">
                <AlertTitle>Couldn’t load snapshots</AlertTitle>
                <AlertDescription className="break-words">{error}</AlertDescription>
              </div>
            </Alert>
          ) : snapshots.length === 0 ? (
            <Alert variant="muted" className="m-3 border-dashed">
              No snapshots yet. Take one before risky changes, or let agent
              sessions create them automatically.
            </Alert>
          ) : (
            <ul>
              {snapshots.map((snapshot) => (
                <SnapshotRow
                  busy={busy}
                  key={snapshot.ref}
                  onDelete={handleDelete}
                  onRename={handleRename}
                  onSelect={setSelectedSha}
                  selected={snapshot.sha === selectedSha}
                  snapshot={snapshot}
                />
              ))}
            </ul>
          )}
        </div>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-col">
        {notice ? (
          <Alert variant="muted" className="m-3 mb-0">
            {notice}
          </Alert>
        ) : null}
        {selected ? (
          <SnapshotDetail busy={busy} onRestore={handleRestore} snapshot={selected} />
        ) : (
          <div className="p-4">
            <Alert variant="muted" className="border-dashed p-12 text-center">
              Select a snapshot to compare it with the current working tree.
            </Alert>
          </div>
        )}
      </section>
    </div>
  );
}

/** A single snapshot in the sidebar: select, inline-rename, or delete. */
function SnapshotRow({
  busy,
  onDelete,
  onRename,
  onSelect,
  selected,
  snapshot,
}: {
  busy: boolean;
  onDelete: (sha: string) => Promise<void>;
  onRename: (sha: string, label: string) => Promise<void>;
  onSelect: (sha: string) => void;
  selected: boolean;
  snapshot: Snapshot;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(snapshot.label);
  const [confirming, setConfirming] = useState(false);

  function startEditing() {
    setDraft(snapshot.label);
    setEditing(true);
  }

  function commitRename() {
    const label = draft.trim();
    setEditing(false);
    if (label && label !== snapshot.label) void onRename(snapshot.sha, label);
  }

  return (
    <li
      className={cn(
        "group relative border-b border-border/60 transition-colors",
        selected ? "bg-background" : "hover:bg-muted/50",
      )}
    >
      {editing ? (
        <div className="flex items-center gap-1.5 px-3 py-2">
          <input
            ref={(node) => node?.focus()}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitRename();
              if (event.key === "Escape") setEditing(false);
            }}
            className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-1 text-xs"
            aria-label="Snapshot label"
          />
          <Button disabled={busy} onClick={commitRename} size="icon-sm" type="button" variant="ghost">
            <Check className="size-3.5" />
          </Button>
          <Button onClick={() => setEditing(false)} size="icon-sm" type="button" variant="ghost">
            <X className="size-3.5" />
          </Button>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => onSelect(snapshot.sha)}
            className="w-full px-3 py-2 pr-16 text-left"
          >
            <span className="block truncate text-xs font-medium">{snapshot.label}</span>
            <span className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
              <span className="font-mono">{snapshot.sha.slice(0, 7)}</span>
              <span>{new Date(snapshot.createdAt).toLocaleString()}</span>
            </span>
          </button>
          <div className="absolute right-2 top-1.5 flex items-center gap-0.5">
            {confirming ? (
              <>
                <Button
                  disabled={busy}
                  onClick={() => {
                    setConfirming(false);
                    void onDelete(snapshot.sha);
                  }}
                  size="icon-sm"
                  title="Confirm delete"
                  type="button"
                  variant="ghost"
                  className="text-red-600 hover:text-red-600"
                >
                  <Check className="size-3.5" />
                </Button>
                <Button
                  onClick={() => setConfirming(false)}
                  size="icon-sm"
                  title="Cancel"
                  type="button"
                  variant="ghost"
                >
                  <X className="size-3.5" />
                </Button>
              </>
            ) : (
              <span className="hidden items-center gap-0.5 group-hover:flex">
                <Button
                  disabled={busy}
                  onClick={startEditing}
                  size="icon-sm"
                  title="Rename snapshot"
                  type="button"
                  variant="ghost"
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => setConfirming(true)}
                  size="icon-sm"
                  title="Delete snapshot"
                  type="button"
                  variant="ghost"
                  className="text-muted-foreground hover:text-red-600"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </span>
            )}
          </div>
        </>
      )}
    </li>
  );
}

function SnapshotDetail({
  busy,
  onRestore,
  snapshot,
}: {
  busy: boolean;
  onRestore: (sha: string) => Promise<void>;
  snapshot: Snapshot;
}) {
  const [files, setFiles] = useState<SnapshotChange[]>([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [diff, setDiff] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let active = true;
    setConfirming(false);
    setError(null);
    void getSnapshotFiles(snapshot.sha)
      .then((next) => {
        if (!active) return;
        setFiles(next);
        setSelectedPath((current) =>
          current && next.some((file) => file.path === current)
            ? current
            : (next[0]?.path ?? ""),
        );
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      active = false;
    };
  }, [snapshot.sha]);

  useEffect(() => {
    if (!selectedPath) {
      setDiff("");
      return;
    }
    let active = true;
    void getSnapshotDiff(snapshot.sha, selectedPath)
      .then((next) => {
        if (active) setDiff(next);
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      active = false;
    };
  }, [snapshot.sha, selectedPath]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <h2 className="truncate text-[13px] font-semibold tracking-tight">
            {snapshot.label}
          </h2>
          <p className="text-[10px] text-muted-foreground">
            {files.length
              ? `${files.length} file(s) differ from the current working tree.`
              : "Identical to the current working tree."}
          </p>
        </div>
        {confirming ? (
          <span className="flex shrink-0 items-center gap-1.5">
            <Button
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                void onRestore(snapshot.sha);
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
            title="Reset the working tree to this snapshot (a pre-restore snapshot is taken first)"
            type="button"
            variant="outline"
          >
            <RotateCcw className="size-3.5" />
            Restore…
          </Button>
        )}
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

/** Shared file-list + diff layout (also used by the agent Changes tab). */
export function ChangedFilesWithDiff({
  diff,
  error,
  files,
  onSelectPath,
  selectedPath,
}: {
  diff: string;
  error: string | null;
  files: SnapshotChange[];
  onSelectPath: (path: string) => void;
  selectedPath: string;
}) {
  if (error) {
    return (
      <div className="p-4">
        <Alert variant="destructive">
          <CircleAlert />
          <div className="min-w-0">
            <AlertTitle>Couldn’t load this snapshot</AlertTitle>
            <AlertDescription className="break-words">{error}</AlertDescription>
          </div>
        </Alert>
      </div>
    );
  }
  return (
    <div className="grid min-h-0 flex-1 xl:grid-cols-[260px_minmax(0,1fr)]">
      <ul className="min-h-0 overflow-auto border-r border-border">
        {files.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              onClick={() => onSelectPath(file.path)}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors",
                file.path === selectedPath ? "bg-background" : "hover:bg-muted/50",
              )}
            >
              <span
                className={cn(
                  "w-3 shrink-0 font-mono text-[10px]",
                  file.status === "A" && "text-emerald-600",
                  file.status === "D" && "text-red-600",
                  file.status === "M" && "text-amber-600",
                )}
              >
                {file.status}
              </span>
              <span className="truncate">{file.path}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="relative min-h-0 min-w-0">
        {selectedPath ? (
          <DiffViewer diff={diff || "No diff for this file."} />
        ) : (
          <div className="p-4">
            <Alert variant="muted" className="border-dashed p-8 text-center">
              Select a file to see how it differs from the snapshot.
            </Alert>
          </div>
        )}
      </div>
    </div>
  );
}
