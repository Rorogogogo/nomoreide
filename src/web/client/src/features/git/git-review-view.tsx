import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { getGitDiff, getGitFiles, type DashboardData } from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DiffViewer, diffStats } from "./diff-viewer";
import { ChangedFilesList } from "./changed-files-list";
import { FileTree } from "./file-tree";
import { FileViewer } from "./file-viewer";
import { nextChangeDecision } from "./review-navigation";
import { GitGraphView } from "./git-graph-view";

type GitTab = "changes" | "graph";
type ChangesMode = "changes" | "all";

export function GitReviewView({
  data,
}: {
  data: DashboardData;
}) {
  const [tab, setTab] = useState<GitTab>("changes");
  const [mode, setMode] = useState<ChangesMode>("changes");
  const [selectedFile, setSelectedFile] = useState(data.git.status?.files[0]?.path ?? "");
  const [selectedTreeFile, setSelectedTreeFile] = useState("");
  const [allFiles, setAllFiles] = useState<string[]>([]);
  const [allFilesError, setAllFilesError] = useState<string | null>(null);
  const [diff, setDiff] = useState("");
  const [diffError, setDiffError] = useState<string | null>(null);
  const [activeHunkIndex, setActiveHunkIndex] = useState(0);
  const [pendingNextFilePath, setPendingNextFilePath] = useState<string | null>(null);
  const files = data.git.status?.files ?? [];
  const filePaths = useMemo(() => files.map((file) => file.path), [files]);
  const stats = useMemo(() => diffStats(diff), [diff]);

  useEffect(() => {
    const firstFile = data.git.status?.files[0]?.path ?? "";
    setSelectedFile((current) =>
      current && data.git.status?.files.some((file) => file.path === current)
        ? current
        : firstFile,
    );
  }, [data.git.status?.files]);

  useEffect(() => {
    if (mode !== "all" || allFiles.length > 0) return;
    let active = true;
    setAllFilesError(null);
    void getGitFiles()
      .then((next) => {
        if (active) setAllFiles(next);
      })
      .catch((caught) => {
        if (active) setAllFilesError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      active = false;
    };
  }, [mode, allFiles.length]);

  useEffect(() => {
    if (!selectedFile) {
      setDiff("");
      return;
    }

    let active = true;
    setDiffError(null);
    void getGitDiff(selectedFile)
      .then((nextDiff) => {
        if (active) {
          setDiff(nextDiff);
          setActiveHunkIndex(0);
          setPendingNextFilePath(null);
        }
      })
      .catch((caught) => {
        if (active) setDiffError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      active = false;
    };
  }, [selectedFile]);

  function selectFile(path: string) {
    setActiveHunkIndex(0);
    setPendingNextFilePath(null);
    setSelectedFile(path);
  }

  function goToNextChange() {
    const decision = nextChangeDecision({
      activeHunkIndex,
      filePaths,
      hunkCount: stats.hunks,
      pendingNextFilePath,
      selectedFile,
    });

    if (decision.kind === "hunk") {
      setPendingNextFilePath(null);
      setActiveHunkIndex(decision.activeHunkIndex);
    } else if (decision.kind === "confirm-next-file") {
      setPendingNextFilePath(decision.filePath);
    } else if (decision.kind === "file") {
      selectFile(decision.filePath);
    } else {
      setPendingNextFilePath(null);
    }
  }

  function goToPreviousChange() {
    setPendingNextFilePath(null);
    if (activeHunkIndex > 0) {
      setActiveHunkIndex((current) => current - 1);
      return;
    }

    const currentFileIndex = files.findIndex((file) => file.path === selectedFile);
    const previousFile = files[currentFileIndex - 1];
    if (previousFile) {
      selectFile(previousFile.path);
    }
  }

  const currentFileIndex = files.findIndex((file) => file.path === selectedFile);
  const hasNextChange = Boolean(
    (stats.hunks && activeHunkIndex < stats.hunks - 1) ||
      files[currentFileIndex + 1],
  );
  const hasPreviousChange = Boolean(
    activeHunkIndex > 0 || files[currentFileIndex - 1],
  );
  const navigationHint = pendingNextFilePath
    ? `End of file. Click Next again to open ${pendingNextFilePath}.`
    : null;

  const tabButtonClass = (active: boolean) =>
    `rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
      active
        ? "bg-foreground text-background"
        : "text-muted-foreground hover:text-foreground"
    }`;

  const modeButtonClass = (active: boolean) =>
    `flex-1 px-2 py-0.5 text-[11px] font-medium transition-colors ${
      active
        ? "bg-foreground text-background"
        : "text-muted-foreground hover:text-foreground"
    }`;

  const modifiedPaths = useMemo(() => new Set(files.map((file) => file.path)), [files]);

  function viewDiffForTreeFile() {
    if (!selectedTreeFile) return;
    setMode("changes");
    selectFile(selectedTreeFile);
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-card/85">
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-card/95 px-3 py-1">
        <button
          type="button"
          className={tabButtonClass(tab === "changes")}
          onClick={() => setTab("changes")}
        >
          Changes
        </button>
        <button
          type="button"
          className={tabButtonClass(tab === "graph")}
          onClick={() => setTab("graph")}
        >
          Tree
        </button>
      </div>

      <div className="min-h-0 flex-1">
        {tab === "graph" ? (
          <GitGraphView branches={data.git.branches ?? []} />
        ) : (
    <div className="grid h-full min-h-0 overflow-hidden border-0 bg-card/85 xl:grid-cols-[320px_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col overflow-hidden">
        <div className="flex shrink-0 gap-0.5 border-b border-border bg-card/95 p-1">
          <button
            className={modeButtonClass(mode === "changes")}
            onClick={() => setMode("changes")}
            type="button"
          >
            Changes
          </button>
          <button
            className={modeButtonClass(mode === "all")}
            onClick={() => setMode("all")}
            type="button"
          >
            All files
          </button>
        </div>
        {mode === "changes" ? (
          <ChangedFilesList
            branch={data.git.status?.branch || undefined}
            error={data.git.error}
            files={data.git.status?.files ?? []}
            selectedFile={selectedFile}
            onSelectFile={selectFile}
            root={data.git.cwd}
          />
        ) : allFilesError ? (
          <Alert variant="destructive" className="m-3">
            {allFilesError}
          </Alert>
        ) : (
          <FileTree
            branch={data.git.status?.branch || undefined}
            onSelectFile={setSelectedTreeFile}
            paths={allFiles}
            root={data.git.cwd}
            selectedFile={selectedTreeFile}
            status={data.git.status?.files ?? []}
          />
        )}
      </aside>

      {mode === "all" ? (
        <FileViewer
          isModified={modifiedPaths.has(selectedTreeFile)}
          onViewDiff={viewDiffForTreeFile}
          path={selectedTreeFile}
        />
      ) : (
      <section className="flex min-h-0 min-w-0 flex-col border-l border-border bg-white">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-1.5">
          <div className="min-w-0">
            <h2 className="truncate text-[13px] font-semibold tracking-tight">
              {selectedFile || "Diff"}
            </h2>
            <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
              <span>Long rows wrap inside the editor pane.</span>
              {stats.additions || stats.deletions ? (
                <span className="flex items-center gap-1 font-mono">
                  <span className="text-emerald-700">+{stats.additions}</span>
                  <span className="text-red-700">-{stats.deletions}</span>
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {navigationHint ? (
              <span className="max-w-72 truncate rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
                {navigationHint}
              </span>
            ) : null}
            <Button
              disabled={!selectedFile || !hasPreviousChange}
              onClick={goToPreviousChange}
              size="sm"
              type="button"
              variant="outline"
            >
              <ArrowUp />
              Previous
            </Button>
            <Button
              disabled={!selectedFile || !hasNextChange}
              onClick={goToNextChange}
              size="sm"
              type="button"
              variant="outline"
            >
              <ArrowDown />
              Next
            </Button>
          </div>
        </div>
        <div className="relative min-h-0 min-w-0 flex-1">
          {diffError ? (
            <div className="p-4">
              <Alert variant="destructive">{diffError}</Alert>
            </div>
          ) : selectedFile ? (
            <DiffViewer
              activeHunkIndex={activeHunkIndex}
              diff={diff || "No unstaged diff for this file."}
            />
          ) : (
            <div className="p-4">
              <Alert variant="muted" className="border-dashed p-12 text-center">
                Select a changed file to inspect its diff.
              </Alert>
            </div>
          )}
        </div>
      </section>
      )}
    </div>
        )}
      </div>
    </div>
  );
}
