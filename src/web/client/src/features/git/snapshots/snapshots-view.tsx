import { useCallback, useEffect, useState } from "react";
import { Camera, History, RotateCcw } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  createSnapshot,
  getSnapshotDiff,
  getSnapshotFiles,
  listSnapshots,
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
              {error}
            </Alert>
          ) : snapshots.length === 0 ? (
            <Alert variant="muted" className="m-3 border-dashed">
              No snapshots yet. Take one before risky changes, or let agent
              sessions create them automatically.
            </Alert>
          ) : (
            <ul>
              {snapshots.map((snapshot) => (
                <li key={snapshot.ref}>
                  <button
                    type="button"
                    onClick={() => setSelectedSha(snapshot.sha)}
                    className={cn(
                      "w-full border-b border-border/60 px-3 py-2 text-left transition-colors",
                      snapshot.sha === selectedSha
                        ? "bg-background"
                        : "hover:bg-muted/50",
                    )}
                  >
                    <span className="block truncate text-xs font-medium">
                      {snapshot.label}
                    </span>
                    <span className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                      <span className="font-mono">{snapshot.sha.slice(0, 7)}</span>
                      <span>{new Date(snapshot.createdAt).toLocaleString()}</span>
                    </span>
                  </button>
                </li>
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
        <Alert variant="destructive">{error}</Alert>
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
