import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, FolderGit2 } from "lucide-react";
import {
  getGitDiff,
  getGitFiles,
  gitStage,
  gitUnstage,
  type DashboardData,
} from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AgentMark } from "../agent/ai-spark";
import { useAgentDock } from "../agent/chat/agent-context";
import { absolutePath } from "../agent/chat/drag-to-agent";
import { DiffViewer, diffStats } from "./diff-viewer";
import { ChangedFilesList, type StagingHandlers } from "./changed-files-list";
import { CommitComposer } from "./commit-composer";
import { FileTree } from "./file-tree";
import { FileViewer } from "./file-viewer";
import { nextChangeDecision } from "./review-navigation";
import { GitGraphView } from "./git-graph-view";
import { MultiRepoBoard } from "./multi-repo-board";
import { LargestFilesView } from "./largest-files-view";
import { SnapshotsView } from "./snapshots/snapshots-view";

type GitTab =
  | "changes"
  | "board"
  | "all"
  | "graph"
  | "largest"
  | "snapshots";
type ChangesMode = "changes" | "tree";

export function GitReviewView({
  data,
  onRefresh,
}: {
  data: DashboardData;
  /** Reload dashboard data after a staging/commit/push mutation. */
  onRefresh?: () => void;
}) {
  const { insertPath } = useAgentDock();
  const [stagingBusy, setStagingBusy] = useState(false);
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
  const [locallyModifiedPaths, setLocallyModifiedPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const statusFiles = data.git.status?.files ?? [];
  const files = useMemo(() => {
    const seen = new Set(statusFiles.map((file) => file.path));
    const localOnly = [...locallyModifiedPaths]
      .filter((path) => !seen.has(path))
      .sort()
      .map((path) => ({ path, index: " ", workingTree: "M" }));
    return [...statusFiles, ...localOnly];
  }, [statusFiles, locallyModifiedPaths]);
  const filePaths = useMemo(() => files.map((file) => file.path), [files]);
  const stats = useMemo(() => diffStats(diff), [diff]);

  const runStaging = useCallback(
    async (action: (paths: string[]) => Promise<void>, paths: string[]) => {
      if (!paths.length) return;
      setStagingBusy(true);
      try {
        await action(paths);
        onRefresh?.();
      } finally {
        setStagingBusy(false);
      }
    },
    [onRefresh],
  );

  const staging: StagingHandlers | undefined = onRefresh
    ? {
        busy: stagingBusy,
        onStage: (paths) => void runStaging(gitStage, paths),
        onUnstage: (paths) => void runStaging(gitUnstage, paths),
      }
    : undefined;

  useEffect(() => {
    const firstFile = files[0]?.path ?? "";
    setSelectedFile((current) =>
      current && files.some((file) => file.path === current) ? current : firstFile,
    );
  }, [files]);

  useEffect(() => {
    if (tab !== "all" || allFiles.length > 0) return;
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
  }, [tab, allFiles.length]);

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

  const modifiedPaths = useMemo(() => {
    const paths = new Set(files.map((file) => file.path));
    for (const path of locallyModifiedPaths) paths.add(path);
    return paths;
  }, [files, locallyModifiedPaths]);

  if (!data.git.selectedRepository) {
    return <NoRepositoryEmptyState />;
  }

  function viewDiffForTreeFile() {
    if (!selectedTreeFile) return;
    setTab("changes");
    setMode("changes");
    selectFile(selectedTreeFile);
  }

  function handleTreeFileSaved(path: string) {
    setLocallyModifiedPaths((current) => new Set(current).add(path));
    setSelectedTreeFile(path);
    setTab("changes");
    setMode("changes");
    selectFile(path);
  }

  // Jump from the ranking straight to a file in the All-files viewer.
  function openFileInViewer(path: string) {
    setSelectedTreeFile(path);
    setTab("all");
  }

  function sendFilePathToAgentInput(path: string) {
    if (!path) return;
    insertPath(absolutePath(data.git.cwd, path));
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
          aria-label="Show changed files across all repositories"
          className={tabButtonClass(tab === "board")}
          onClick={() => setTab("board")}
        >
          Board
        </button>
        <button
          type="button"
          aria-label="Open all tracked files"
          className={tabButtonClass(tab === "all")}
          onClick={() => setTab("all")}
        >
          All files
        </button>
        <button
          type="button"
          className={tabButtonClass(tab === "graph")}
          onClick={() => setTab("graph")}
        >
          Tree
        </button>
        <button
          type="button"
          className={tabButtonClass(tab === "largest")}
          onClick={() => setTab("largest")}
        >
          Largest files
        </button>
        <button
          type="button"
          className={tabButtonClass(tab === "snapshots")}
          onClick={() => setTab("snapshots")}
        >
          Snapshots
        </button>
      </div>

      <div className="min-h-0 flex-1">
        {tab === "board" ? (
          <MultiRepoBoard currentRepoPath={data.git.cwd} />
        ) : tab === "graph" ? (
          <GitGraphView branches={data.git.branches ?? []} />
        ) : tab === "largest" ? (
          <LargestFilesView onOpenFile={openFileInViewer} root={data.git.cwd} />
        ) : tab === "snapshots" ? (
          <SnapshotsView />
        ) : tab === "all" ? (
          <div className="grid h-full min-h-0 overflow-hidden border-0 bg-card/85 xl:grid-cols-[320px_minmax(0,1fr)]">
            <aside className="flex min-h-0 flex-col overflow-hidden">
              {allFilesError ? (
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
                  status={files}
                />
              )}
            </aside>
            <FileViewer
              isModified={modifiedPaths.has(selectedTreeFile)}
              onFileSaved={handleTreeFileSaved}
              onSendToAi={() => sendFilePathToAgentInput(selectedTreeFile)}
              onViewDiff={viewDiffForTreeFile}
              path={selectedTreeFile}
            />
          </div>
        ) : (
          <div className="grid h-full min-h-0 overflow-hidden border-0 bg-card/85 xl:grid-cols-[320px_minmax(0,1fr)]">
            <aside className="flex min-h-0 flex-col overflow-hidden">
              <div className="flex shrink-0 gap-0.5 border-b border-border bg-card/95 p-1">
                <button
                  aria-label="Show changed files as a list"
                  className={modeButtonClass(mode === "changes")}
                  onClick={() => setMode("changes")}
                  type="button"
                >
                  Changes
                </button>
                <button
                  aria-label="Show changed files as a tree"
                  className={modeButtonClass(mode === "tree")}
                  onClick={() => setMode("tree")}
                  type="button"
                >
                  Tree
                </button>
              </div>
              {mode === "changes" ? (
                <ChangedFilesList
                  branch={data.git.status?.branch || undefined}
                  error={data.git.error}
                  files={files}
                  selectedFile={selectedFile}
                  onSelectFile={selectFile}
                  root={data.git.cwd}
                  staging={staging}
                />
              ) : (
                <FileTree
                  branch={data.git.status?.branch || undefined}
                  defaultExpandAll
                  emptyMessage={data.git.error ?? "No changed files."}
                  onSelectFile={selectFile}
                  paths={filePaths}
                  root={data.git.cwd}
                  selectedFile={selectedFile}
                  status={files}
                  title="Changes"
                />
              )}
              {onRefresh && data.git.status ? (
                <CommitComposer
                  branch={data.git.status.branch || undefined}
                  files={files}
                  onDone={onRefresh}
                />
              ) : null}
            </aside>

            <section className="flex min-h-0 min-w-0 flex-col border-l border-border bg-card">
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
                  <Button
                    aria-label="Send selected file to AI input"
                    className="size-8"
                    disabled={!selectedFile}
                    onClick={() => sendFilePathToAgentInput(selectedFile)}
                    size="icon"
                    title="Send selected file path to AI input"
                    type="button"
                    variant="outline"
                  >
                    <AgentMark className="size-4" />
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
          </div>
        )}
      </div>
    </div>
  );
}

function NoRepositoryEmptyState() {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center">
      <div className="max-w-sm">
        <FolderGit2 className="mx-auto size-8 text-muted-foreground/50" />
        <p className="mt-3 text-sm font-medium">No Git project registered</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Add a folder that is a Git worktree to review changes, browse files,
          and inspect history. Use the project switcher in the sidebar to add one.
        </p>
      </div>
    </div>
  );
}
