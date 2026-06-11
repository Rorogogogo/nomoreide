import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  FolderGit2,
  FolderPlus,
  GripVertical,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import {
  getGitOverview,
  gitStage,
  gitUnstage,
  postForm,
  setGitBoard,
  type GitRepoOverview,
} from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ChangedFilesList, type StagingHandlers } from "./changed-files-list";
import { CommitComposer } from "./commit-composer";
import { DiffDrawer } from "./diff-drawer";
import { pathName } from "./path-utils";
import { FolderPickerDialog } from "./repository-selector";

interface OpenFile {
  repo: string;
  file: string;
}

/** At most this many repos on the board — keeps it a focused glance, not a wall. */
const MAX_COLUMNS = 5;
/** Below this width a column gets too cramped to read, so we show fewer instead. */
const MIN_COLUMN_WIDTH = 240;
const COLUMN_GAP = 8;
/** Matches the Add tile's `w-44` (176px) plus one gap. */
const ADD_TILE_WIDTH = 176 + COLUMN_GAP;

/**
 * Curated repo-per-column overview. The board shows only the repos the user
 * pinned (or every repo, until they curate), laid out to fit the width with no
 * horizontal scroll. Drag a column header to reorder, × to drop it from the
 * board, and the trailing tile to pin more. Clicking a file opens a read-only
 * {@link DiffDrawer} — the board itself stays an at-a-glance summary.
 */
export function MultiRepoBoard({ currentRepoPath }: { currentRepoPath?: string }) {
  const [repos, setRepos] = useState<GitRepoOverview[] | null>(null);
  const [board, setBoardNames] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<OpenFile | null>(null);
  const dragIndex = useRef<number | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const [rowWidth, setRowWidth] = useState(0);

  // Track the row width so the number of visible columns can follow it.
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      setRowWidth(entries[0].contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [repos]);

  const refresh = useCallback(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void getGitOverview()
      .then((overview) => {
        if (!active) return;
        setRepos(overview.repos);
        setBoardNames(overview.board);
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(refresh, [refresh]);

  // Re-fetch overview after a stage/unstage/commit without flashing the loading
  // spinner — the column that mutated stays put, only its files update.
  const reloadQuiet = useCallback(() => {
    void getGitOverview()
      .then((overview) => {
        setRepos(overview.repos);
        setBoardNames(overview.board);
      })
      .catch((caught) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      });
  }, []);

  // Optimistically apply a new board order, then persist it.
  const commitBoard = useCallback((next: string[]) => {
    setBoardNames(next);
    void setGitBoard(next).catch((caught) => {
      setError(caught instanceof Error ? caught.message : String(caught));
    });
  }, []);

  // Register a brand-new repository by path, then pin it to the board. Used by
  // the Add tile so the user never has to leave the board to onboard a repo.
  const registerAndPin = useCallback(
    async (rawPath: string): Promise<string | null> => {
      const path = rawPath.trim();
      if (!path.startsWith("/")) {
        return "Please add an absolute path (it must start with /).";
      }
      try {
        const name = pathName(path);
        await postForm("/api/git/repositories", { name, path });
        const overview = await getGitOverview();
        setRepos(overview.repos);
        const nextBoard = (
          overview.board.includes(name) ? overview.board : [...overview.board, name]
        ).slice(0, MAX_COLUMNS);
        setBoardNames(nextBoard);
        await setGitBoard(nextBoard);
        return null;
      } catch (caught) {
        return caught instanceof Error ? caught.message : String(caught);
      }
    },
    [],
  );

  const reposByName = new Map((repos ?? []).map((repo) => [repo.name, repo]));
  const pinned = board
    .map((name) => reposByName.get(name))
    .filter((repo): repo is GitRepoOverview => Boolean(repo))
    .slice(0, MAX_COLUMNS);
  const unpinned = (repos ?? []).filter((repo) => !board.includes(repo.name));
  // Always offer the Add tile when the board has room: even with no unpinned
  // repos left, the user can still register a brand-new repository from it.
  const canAdd = pinned.length < MAX_COLUMNS;

  // How many columns actually fit: drop the count (never the width) as the row
  // narrows, so columns stay readable and the row never scrolls sideways.
  const usableWidth = Math.max(0, rowWidth - (canAdd ? ADD_TILE_WIDTH : 0));
  const fitByWidth =
    rowWidth === 0
      ? MAX_COLUMNS
      : Math.max(1, Math.floor((usableWidth + COLUMN_GAP) / (MIN_COLUMN_WIDTH + COLUMN_GAP)));
  const visibleCount = Math.min(pinned.length, fitByWidth);
  const visible = pinned.slice(0, visibleCount);
  const hiddenCount = pinned.length - visibleCount;

  function handleDrop(targetIndex: number) {
    const from = dragIndex.current;
    dragIndex.current = null;
    if (from === null || from === targetIndex) return;
    const next = [...board];
    const [moved] = next.splice(from, 1);
    next.splice(targetIndex, 0, moved);
    commitBoard(next);
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-card/85">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-card/95 px-3 py-1.5">
        <span className="flex items-center gap-1.5 text-[12px] font-semibold tracking-tight">
          <FolderGit2 className="size-3.5" />
          Repositories
          {repos ? (
            <Badge variant="secondary" className="ml-1">
              {pinned.length}
              {repos.length > pinned.length ? ` / ${repos.length}` : ""}
            </Badge>
          ) : null}
          {hiddenCount > 0 ? (
            <span className="ml-1 text-[10px] font-normal text-muted-foreground">
              +{hiddenCount} hidden — widen the window or remove one
            </span>
          ) : null}
        </span>
        <Button
          aria-label="Refresh repositories"
          disabled={loading}
          onClick={refresh}
          size="sm"
          type="button"
          variant="outline"
        >
          <RefreshCw className={loading ? "animate-spin" : undefined} />
          Refresh
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {error ? (
          <Alert variant="destructive" className="m-3">
            {error}
          </Alert>
        ) : repos && repos.length === 0 ? (
          <Alert variant="muted" className="m-3 text-center">
            No Git projects registered. Add one with the project picker in the header.
          </Alert>
        ) : (
          <div className="flex h-full min-h-0 gap-2 p-2" ref={rowRef}>
            {visible.map((repo, index) => (
              <RepoColumn
                key={repo.name}
                repo={repo}
                isCurrent={Boolean(currentRepoPath) && repo.path === currentRepoPath}
                selectedFile={open?.repo === repo.name ? open.file : ""}
                onSelectFile={(file) => setOpen({ repo: repo.name, file })}
                onRemove={() => commitBoard(board.filter((name) => name !== repo.name))}
                onMutated={reloadQuiet}
                onDragStart={() => {
                  dragIndex.current = index;
                }}
                onDropColumn={() => handleDrop(index)}
              />
            ))}
            {canAdd ? (
              <AddRepoTile
                unpinned={unpinned}
                onAdd={(name) => commitBoard([...board, name].slice(0, MAX_COLUMNS))}
                onRegister={registerAndPin}
              />
            ) : null}
          </div>
        )}
      </div>

      {open ? (
        <DiffDrawer repo={open.repo} file={open.file} onClose={() => setOpen(null)} />
      ) : null}
    </div>
  );
}

function RepoColumn({
  repo,
  isCurrent,
  selectedFile,
  onSelectFile,
  onRemove,
  onMutated,
  onDragStart,
  onDropColumn,
}: {
  repo: GitRepoOverview;
  isCurrent: boolean;
  selectedFile: string;
  onSelectFile: (file: string) => void;
  onRemove: () => void;
  /** Re-fetch the board after this column stages/unstages/commits. */
  onMutated: () => void;
  onDragStart: () => void;
  onDropColumn: () => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [stagingBusy, setStagingBusy] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);

  // Stage/unstage scoped to this column's repo, then refresh the board. Each
  // column owns its own busy flag so one repo's action doesn't freeze the rest.
  const runStaging = useCallback(
    async (action: (paths: string[], repo?: string) => Promise<void>, paths: string[]) => {
      if (!paths.length) return;
      setStagingBusy(true);
      try {
        await action(paths, repo.name);
        onMutated();
      } finally {
        setStagingBusy(false);
      }
    },
    [repo.name, onMutated],
  );

  const staging: StagingHandlers = {
    busy: stagingBusy,
    onStage: (paths) => void runStaging(gitStage, paths),
    onUnstage: (paths) => void runStaging(gitUnstage, paths),
  };

  // Files git will record on commit — staged index entries (not untracked/clean).
  const stagedCount = repo.files.filter(
    (file) => file.index.trim() && file.index !== "?",
  ).length;

  const CommitChevron = commitOpen ? ChevronDown : ChevronRight;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: column is a drag-and-drop reorder target; drag handlers belong on the container.
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-card",
        isCurrent && "border-primary/60 ring-1 ring-primary/30",
        dragOver && "ring-2 ring-foreground/40",
      )}
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={() => {
        setDragOver(false);
        onDropColumn();
      }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drag handle for reordering columns. */}
      <div
        className="flex shrink-0 cursor-grab items-center justify-between gap-1 border-b border-border bg-muted/40 px-1.5 py-1.5 active:cursor-grabbing"
        draggable
        onDragStart={onDragStart}
      >
        <span className="flex min-w-0 items-center gap-1">
          <GripVertical className="size-3.5 shrink-0 text-muted-foreground/60" />
          <span className="truncate text-[12px] font-semibold" title={repo.path}>
            {repo.name}
          </span>
          {isCurrent ? (
            <span
              className="flex shrink-0 items-center gap-0.5 rounded bg-primary px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-primary-foreground"
              title="The repository currently selected across NoMoreIDE"
            >
              <Check className="size-2.5" />
              Current
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <span className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
            {repo.ahead ? (
              <span className="flex items-center" title={`${repo.ahead} ahead`}>
                <ArrowUp className="size-3" />
                {repo.ahead}
              </span>
            ) : null}
            {repo.behind ? (
              <span className="flex items-center" title={`${repo.behind} behind`}>
                <ArrowDown className="size-3" />
                {repo.behind}
              </span>
            ) : null}
          </span>
          <button
            aria-label={`Remove ${repo.name} from board`}
            className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
            onClick={onRemove}
            title="Remove from board (stays registered)"
            type="button"
          >
            <X className="size-3.5" />
          </button>
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <ChangedFilesList
          branch={repo.branch || undefined}
          error={repo.error}
          files={repo.files}
          onSelectFile={onSelectFile}
          root={repo.path}
          selectedFile={selectedFile}
          staging={staging}
        />
      </div>
      {/* Collapsed by default so the board stays a glance; click to commit. */}
      <div className="shrink-0 border-t border-border">
        <button
          aria-expanded={commitOpen}
          className="flex w-full items-center gap-1.5 bg-muted/40 px-2 py-1 text-left text-[11px] font-semibold uppercase tracking-tight text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={() => setCommitOpen((open) => !open)}
          type="button"
        >
          <CommitChevron className="size-3.5 shrink-0" />
          <span className="flex-1">Commit</span>
          {stagedCount ? (
            <Badge size="small" variant="secondary">
              {stagedCount} staged
            </Badge>
          ) : null}
        </button>
        {commitOpen ? (
          <CommitComposer
            branch={repo.branch || undefined}
            files={repo.files}
            onDone={onMutated}
            repo={repo.name}
          />
        ) : null}
      </div>
    </div>
  );
}

function AddRepoTile({
  unpinned,
  onAdd,
  onRegister,
}: {
  unpinned: GitRepoOverview[];
  onAdd: (name: string) => void;
  /** Register a new repo by absolute path. Resolves to an error message, or null on success. */
  onRegister: (path: string) => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [draftPath, setDraftPath] = useState("");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setRect(buttonRef.current?.getBoundingClientRect() ?? null);
    setError(null);
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    function onOutside(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popoverRef.current?.contains(target) || buttonRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  async function register(candidate: string) {
    setBusy(true);
    setError(null);
    const message = await onRegister(candidate);
    setBusy(false);
    if (message) {
      setError(message);
      return false;
    }
    setPath("");
    setOpen(false);
    return true;
  }

  async function submitPath(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await register(path);
  }

  return (
    <div className="w-44 shrink-0">
      <button
        ref={buttonRef}
        className="flex h-full w-full flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-border text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
        onClick={toggle}
        type="button"
      >
        <Plus className="size-5" />
        <span className="text-[12px] font-medium">Add repository</span>
      </button>
      {open && rect
        ? createPortal(
            <div
              ref={popoverRef}
              className="fixed z-[1000] w-72 overflow-hidden rounded-lg border border-border bg-card shadow-xl"
              style={{
                left: Math.max(8, Math.min(rect.left, window.innerWidth - 296)),
                top: Math.min(rect.top, window.innerHeight - 320),
              }}
            >
              {unpinned.length ? (
                <div className="border-b border-border">
                  <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Pin a registered repo
                  </div>
                  <div className="max-h-52 overflow-auto pb-1">
                    {unpinned.map((repo) => (
                      <button
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted"
                        key={repo.name}
                        onClick={() => {
                          onAdd(repo.name);
                          setOpen(false);
                        }}
                        type="button"
                      >
                        <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate" title={repo.path}>
                          {repo.name}
                        </span>
                        {repo.files.length ? (
                          <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                            {repo.files.length}
                          </Badge>
                        ) : null}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="p-2.5">
                <div className="pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Add a new repository
                </div>
                <form className="flex gap-1.5" onSubmit={submitPath}>
                  <Input
                    aria-label="Repository absolute path"
                    className="h-7 flex-1 px-2 font-mono text-[11px]"
                    onChange={(event) => {
                      setPath(event.target.value);
                      setError(null);
                    }}
                    placeholder="/absolute/path/to/repo"
                    value={path}
                  />
                  <Button
                    className="h-7 px-2 text-[11px]"
                    disabled={busy || !path.trim()}
                    size="sm"
                    type="submit"
                  >
                    Add
                  </Button>
                </form>
                <Button
                  className="mt-1.5 h-7 w-full gap-1.5 text-[11px]"
                  disabled={busy}
                  onClick={() => {
                    setDraftPath(path.trim() || "");
                    setBrowsing(true);
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <FolderPlus className="size-3" />
                  Browse folders…
                </Button>
                {error ? (
                  <div className="mt-1.5 text-[10px] text-destructive">{error}</div>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
      {browsing ? (
        <FolderPickerDialog
          confirmLabel="Add repository"
          errorMessage={error}
          initialPath={draftPath || "/"}
          selectedPath={draftPath}
          title="Add Repository"
          onCancel={() => setBrowsing(false)}
          onSelect={setDraftPath}
          onUse={async () => {
            const ok = await register(draftPath);
            if (ok) setBrowsing(false);
          }}
        />
      ) : null}
    </div>
  );
}
