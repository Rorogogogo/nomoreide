import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
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
  X,
} from "lucide-react";
import { gitStage, gitUnstage, type GitRepoOverview } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ChangedFilesList, type StagingHandlers } from "./changed-files-list";
import { CommitComposer } from "./commit-composer";
import { FolderPickerDialog } from "./repository-selector";

/**
 * One repository's column on the board, and the tile that adds another.
 *
 * Split from `multi-repo-board.tsx`, which owns the column set, its order and
 * the shared diff drawer. A column stages, unstages and commits its own repo;
 * it does not know how many others are on the board.
 */

export function RepoColumn({
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
  const t = useT();
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
              title={t("git.board.currentTitle")}
            >
              <Check className="size-2.5" />
              {t("git.board.current")}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <span className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
            {repo.ahead ? (
              <span className="flex items-center" title={t("git.board.aheadTitle", { count: repo.ahead })}>
                <ArrowUp className="size-3" />
                {repo.ahead}
              </span>
            ) : null}
            {repo.behind ? (
              <span className="flex items-center" title={t("git.board.behindTitle", { count: repo.behind })}>
                <ArrowDown className="size-3" />
                {repo.behind}
              </span>
            ) : null}
          </span>
          <button
            aria-label={t("git.board.removeAria", { name: repo.name })}
            className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
            onClick={onRemove}
            title={t("git.board.removeTitle")}
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
          <span className="flex-1">{t("git.commit.title")}</span>
          {stagedCount ? (
            <Badge size="small" variant="secondary">
              {t("git.commit.stagedCount", { count: stagedCount })}
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

export function AddRepoTile({
  unpinned,
  onAdd,
  onRegister,
}: {
  unpinned: GitRepoOverview[];
  onAdd: (name: string) => void;
  /** Register a new repo by absolute path. Resolves to an error message, or null on success. */
  onRegister: (path: string) => Promise<string | null>;
}) {
  const t = useT();
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
        <span className="text-[12px] font-medium">{t("git.board.addRepo")}</span>
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
                    {t("git.board.pinRegistered")}
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
                  {t("git.board.addNew")}
                </div>
                <form className="flex gap-1.5" onSubmit={submitPath}>
                  <Input
                    aria-label={t("git.board.absPathAria")}
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
                    {t("common.add")}
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
                  {t("git.board.browseFolders")}
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
          confirmLabel={t("git.board.addRepo")}
          errorMessage={error}
          initialPath={draftPath || "/"}
          selectedPath={draftPath}
          title={t("git.board.addRepoTitle")}
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
