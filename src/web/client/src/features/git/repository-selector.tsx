import { type FormEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  Download,
  Folder,
  FolderPlus,
  Globe2,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToasts } from "@/components/ui/toast";
import {
  cloneGitRepository,
  deleteGitRepository,
  registerGitRepository,
  selectGitRepository,
  type DashboardData,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { FolderExplorer } from "./folder-explorer";
import { pathName } from "./path-utils";

export function RepositorySelector({
  data,
  onRefresh,
}: {
  data: DashboardData;
  onRefresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [addMode, setAddMode] = useState<"path" | "url">("path");
  const [path, setPath] = useState(data.git.cwd);
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloning, setCloning] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [browseDialogOpen, setBrowseDialogOpen] = useState(false);
  const [draftPath, setDraftPath] = useState(data.git.cwd);
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedRepository = data.git.selectedRepository;
  const selectedName = selectedRepository?.name
    ?? (data.git.cwd ? pathName(data.git.cwd) : "Add Git project");
  const { error: showErrorToast, success: showSuccessToast } = useToasts();
  const picker = repositoryPickerState({
    gitCwd: data.git.cwd,
    typedPath: path,
  });

  useEffect(() => {
    setPath(data.git.cwd);
    setDraftPath(data.git.cwd);
  }, [data.git.cwd]);

  useEffect(() => {
    if (!open) return;

    function closeOnOutsideClick(event: MouseEvent) {
      if (
        containerRef.current &&
        event.target instanceof Node &&
        !containerRef.current.contains(event.target)
      ) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [open]);

  async function selectRepository(name: string) {
    try {
      await selectGitRepository(name);
      setOpen(false);
      await onRefresh();
      showSuccessToast(`Switched to ${name}.`);
    } catch (caught) {
      showErrorToast(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function registerPath(nextPath: string): Promise<boolean> {
    const trimmed = nextPath.trim();
    if (!isAbsolutePath(trimmed)) {
      const message = "Please add an absolute path. Paths beginning with ~ are not expanded here.";
      setAddError(message);
      showErrorToast(message);
      return false;
    }
    try {
      const repoName = pathName(trimmed);
      await registerGitRepository(repoName, trimmed);
      setAddError(null);
      await onRefresh();
      showSuccessToast(`Added Git project ${repoName}.`);
      return true;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setAddError(message);
      showErrorToast(message);
      return false;
    }
  }

  async function removeRepository(name: string) {
    try {
      await deleteGitRepository(name);
      await onRefresh();
      showSuccessToast(`Removed Git project ${name}.`);
    } catch (caught) {
      showErrorToast(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function addRepositoryFromInput(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await registerPath(path);
    if (ok) setOpen(false);
  }

  async function addRepositoryFromUrl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const url = cloneUrl.trim();
    if (!url) return;
    setCloning(true);
    setAddError(null);
    try {
      const { name } = await cloneGitRepository(url);
      setCloneUrl("");
      await onRefresh();
      showSuccessToast(`Cloned and added ${name}.`);
      setOpen(false);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setAddError(message);
      showErrorToast(message);
    } finally {
      setCloning(false);
    }
  }

  function openRepositoryPicker() {
    setAddError(null);
    setDraftPath(picker.selectedPath);
    setBrowseDialogOpen(true);
  }

  return (
    <div className="relative z-50 flex items-center gap-2" ref={containerRef}>
      <Button
        className="max-w-[220px] justify-start gap-2 rounded-md border-border bg-card"
        onClick={() => setOpen((current) => !current)}
        size="sm"
        type="button"
        variant="outline"
      >
        <Folder className="text-muted-foreground" />
        <span className="truncate">{selectedName}</span>
        <ChevronDown className={cn("ml-auto transition-transform", open && "rotate-180")} />
      </Button>
      <Button
        aria-label="Add Git project"
        onClick={openRepositoryPicker}
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus />
      </Button>

      {open ? (
        <div className="absolute right-0 top-10 z-50 w-[min(380px,calc(100vw-2rem))] overflow-hidden rounded-lg border border-border bg-card shadow-lg">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Globe2 className="size-3.5 text-muted-foreground" />
            <div className="text-xs font-semibold">Git Projects</div>
            <Badge className="ml-auto h-5 px-1.5 text-[10px]" variant="outline">
              {data.config.gitRepositories.length}
            </Badge>
          </div>

          <div className="max-h-72 overflow-auto">
            {data.config.gitRepositories.length ? (
              <div className="divide-y divide-border">
                {data.config.gitRepositories.map((repository) => {
                  const selected = repository.name === selectedRepository?.name;
                  return (
                    <div
                      className={cn(
                        "group grid w-full grid-cols-[1fr_auto_auto] items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted",
                        selected && "bg-muted/70",
                      )}
                      key={repository.name}
                    >
                      <button
                        className="min-w-0 text-left"
                        onClick={() => void selectRepository(repository.name)}
                        type="button"
                      >
                        <span className="block truncate text-sm font-medium leading-tight">
                          {repository.name}
                        </span>
                        <span className="block truncate font-mono text-[10px] leading-tight text-muted-foreground">
                          {repository.path}
                        </span>
                      </button>
                      {selected ? <Check className="size-3.5" /> : <span className="size-3.5" />}
                      <Button
                        aria-label={`Remove ${repository.name}`}
                        className="size-6 opacity-0 transition-opacity group-hover:opacity-100"
                        onClick={() => void removeRepository(repository.name)}
                        size="icon"
                        title={`Remove ${repository.name}`}
                        type="button"
                        variant="ghost"
                      >
                        <Trash2 className="size-3.5 text-destructive" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                No saved Git projects yet.
              </div>
            )}
          </div>

          <div className="border-t border-border bg-muted/20 p-2">
            <div className="mb-1.5 flex gap-1 text-[11px]">
              <button
                className={cn(
                  "flex items-center gap-1 rounded px-2 py-0.5 transition-colors",
                  addMode === "path"
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => {
                  setAddMode("path");
                  setAddError(null);
                }}
                type="button"
              >
                <Folder className="size-3" />
                Local path
              </button>
              <button
                className={cn(
                  "flex items-center gap-1 rounded px-2 py-0.5 transition-colors",
                  addMode === "url"
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => {
                  setAddMode("url");
                  setAddError(null);
                }}
                type="button"
              >
                <Download className="size-3" />
                Clone URL
              </button>
            </div>

            {addMode === "path" ? (
              <form className="flex gap-1.5" onSubmit={addRepositoryFromInput}>
                <Input
                  aria-label="Paste absolute path"
                  className="h-7 flex-1 px-2 font-mono text-[11px]"
                  onChange={(event) => {
                    setPath(event.target.value);
                    setAddError(null);
                  }}
                  placeholder="/absolute/path"
                  value={path}
                />
                <Button className="h-7 px-2 text-[11px]" size="sm" type="submit">
                  <Plus className="size-3" />
                  Add
                </Button>
                <Button
                  aria-label="Browse and add Git project"
                  className="h-7 px-2"
                  onClick={openRepositoryPicker}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <FolderPlus className="size-3" />
                </Button>
              </form>
            ) : (
              <form className="flex gap-1.5" onSubmit={addRepositoryFromUrl}>
                <Input
                  aria-label="Git remote URL"
                  className="h-7 flex-1 px-2 font-mono text-[11px]"
                  onChange={(event) => {
                    setCloneUrl(event.target.value);
                    setAddError(null);
                  }}
                  placeholder="https://… or git@host:owner/repo.git"
                  value={cloneUrl}
                />
                <Button
                  className="h-7 px-2 text-[11px]"
                  disabled={cloning || !cloneUrl.trim()}
                  size="sm"
                  type="submit"
                >
                  <Download className="size-3" />
                  {cloning ? "Cloning…" : "Clone"}
                </Button>
              </form>
            )}
            {addError ? (
              <div className="mt-1.5 truncate text-[10px] text-destructive">{addError}</div>
            ) : null}
            {addMode === "url" ? (
              <div className="mt-1 text-[10px] text-muted-foreground">
                Private github.com repos reuse your GitHub login; SSH uses your machine's keys.
                Clones into ~/.nomoreide/repos.
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {browseDialogOpen ? (
        <FolderPickerDialog
          confirmLabel={picker.confirmLabel}
          errorMessage={addError}
          initialPath={picker.initialPath}
          selectedPath={draftPath}
          title="Add Git Project"
          onCancel={() => setBrowseDialogOpen(false)}
          onSelect={setDraftPath}
          onUse={async () => {
            const ok = await registerPath(draftPath);
            if (ok) {
              setBrowseDialogOpen(false);
              setOpen(false);
            }
          }}
        />
      ) : null}
    </div>
  );
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/");
}

export function repositoryPickerState({
  gitCwd,
}: {
  gitCwd: string;
  typedPath: string;
}): { confirmLabel: string; initialPath: string; selectedPath: string } {
  return {
    confirmLabel: "Add Git project",
    initialPath: gitCwd,
    selectedPath: gitCwd,
  };
}

export function FolderPickerDialog({
  confirmLabel = "Use this folder",
  errorMessage,
  initialPath,
  onCancel,
  onSelect,
  onUse,
  selectedPath,
  title = "Choose Git Project Folder",
}: {
  confirmLabel?: string;
  errorMessage?: string | null;
  initialPath: string;
  onCancel: () => void;
  onSelect: (path: string) => void;
  onUse: () => void | Promise<void>;
  selectedPath: string;
  title?: string;
}) {
  return createPortal(
    <div className="fixed inset-0 z-[1000] grid place-items-center bg-black/35 px-4">
      <div className="w-full max-w-2xl rounded-xl border border-border bg-card p-4 shadow-xl">
        <div className="mb-3 flex items-center gap-3">
          <div className="flex size-8 items-center justify-center rounded-lg border border-border bg-background">
            <Folder className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">{title}</div>
            <div className="truncate font-mono text-xs text-muted-foreground">
              {selectedPath}
            </div>
          </div>
          <Button aria-label="Close folder picker" onClick={onCancel} size="icon" variant="ghost">
            <X />
          </Button>
        </div>

        <FolderExplorer
          initialPath={initialPath}
          onSelect={onSelect}
          selectedPath={selectedPath}
        />

        {errorMessage ? (
          <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {errorMessage}
          </div>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onCancel} type="button" variant="outline">
            Cancel
          </Button>
          <Button onClick={() => void onUse()} type="button">
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
