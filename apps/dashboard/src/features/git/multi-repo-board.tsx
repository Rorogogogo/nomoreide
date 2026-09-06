import { useCallback, useEffect, useRef, useState } from "react";
import {
  FolderGit2,
  RefreshCw,
} from "lucide-react";
import {
  getGitOverview,
  postForm,
  setGitBoard,
  type GitRepoOverview,
} from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { DiffDrawer } from "./diff-drawer";
import { pathName } from "./path-utils";
import { AddRepoTile, RepoColumn } from "./repo-column";

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
  const t = useT();
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
        return t("git.board.absolutePathError");
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
    [t],
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
          {t("git.board.repositories")}
          {repos ? (
            <Badge variant="secondary" className="ml-1">
              {pinned.length}
              {repos.length > pinned.length ? ` / ${repos.length}` : ""}
            </Badge>
          ) : null}
          {hiddenCount > 0 ? (
            <span className="ml-1 text-[10px] font-normal text-muted-foreground">
              {t("git.board.hidden", { count: hiddenCount })}
            </span>
          ) : null}
        </span>
        <Button
          aria-label={t("git.board.refreshAria")}
          disabled={loading}
          onClick={refresh}
          size="sm"
          type="button"
          variant="outline"
        >
          <RefreshCw className={loading ? "animate-spin" : undefined} />
          {t("common.refresh")}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {error ? (
          <Alert variant="destructive" className="m-3">
            {error}
          </Alert>
        ) : repos && repos.length === 0 ? (
          <Alert variant="muted" className="m-3 text-center">
            {t("git.board.emptyRegistered")}
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
