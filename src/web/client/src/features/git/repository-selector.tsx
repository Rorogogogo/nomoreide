import { type FormEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Folder, FolderPlus, Globe2, Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToasts } from "@/components/ui/toast";
import { postForm, type DashboardData } from "@/lib/api";
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
  const [path, setPath] = useState(data.git.cwd);
  const [addError, setAddError] = useState<string | null>(null);
  const [browseDialogOpen, setBrowseDialogOpen] = useState(false);
  const [browseMode, setBrowseMode] = useState<"fill" | "add">("add");
  const [draftPath, setDraftPath] = useState(data.git.cwd);
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedRepository = data.git.selectedRepository;
  const selectedName = selectedRepository?.name ?? pathName(data.git.cwd);
  const { error: showErrorToast, success: showSuccessToast } = useToasts();

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
      await postForm("/api/git/select", { name });
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
      await postForm("/api/git/repositories", { name: repoName, path: trimmed });
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

  async function addRepositoryFromInput(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await registerPath(path);
    if (ok) setOpen(false);
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
        onClick={() => {
          setBrowseMode("add");
          setAddError(null);
          setDraftPath(data.git.cwd);
          setBrowseDialogOpen(true);
        }}
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
                    <button
                      className={cn(
                        "grid w-full grid-cols-[1fr_auto] items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted",
                        selected && "bg-muted/70",
                      )}
                      key={repository.name}
                      onClick={() => void selectRepository(repository.name)}
                      type="button"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium leading-tight">
                          {repository.name}
                        </span>
                        <span className="block truncate font-mono text-[10px] leading-tight text-muted-foreground">
                          {repository.path}
                        </span>
                      </span>
                      {selected ? <Check className="size-3.5" /> : null}
                    </button>
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
                aria-label="Browse folders"
                className="h-7 px-2"
                onClick={() => {
                  setBrowseMode("fill");
                  setAddError(null);
                  setDraftPath(path || data.git.cwd);
                  setBrowseDialogOpen(true);
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                <FolderPlus className="size-3" />
              </Button>
            </form>
            {addError ? (
              <div className="mt-1.5 truncate text-[10px] text-destructive">{addError}</div>
            ) : null}
          </div>
        </div>
      ) : null}
      {browseDialogOpen ? (
        <FolderPickerDialog
          confirmLabel={browseMode === "add" ? "Add Git project" : "Use this folder"}
          errorMessage={browseMode === "add" ? addError : null}
          initialPath={browseMode === "add" ? data.git.cwd : path || data.git.cwd}
          selectedPath={draftPath}
          title={browseMode === "add" ? "Add Git Project" : "Choose Git Project Folder"}
          onCancel={() => setBrowseDialogOpen(false)}
          onSelect={setDraftPath}
          onUse={async () => {
            if (browseMode === "add") {
              const ok = await registerPath(draftPath);
              if (ok) {
                setBrowseDialogOpen(false);
                setOpen(false);
              }
            } else {
              setPath(draftPath);
              setAddError(null);
              setBrowseDialogOpen(false);
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

function FolderPickerDialog({
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
