import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Folder, FolderPlus, Globe2, Plus, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  const [draftPath, setDraftPath] = useState(data.git.cwd);
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedRepository = data.git.selectedRepository;
  const selectedName = selectedRepository?.name ?? pathName(data.git.cwd);

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

  const selectPath = useCallback((nextPath: string) => {
    setPath(nextPath);
    setAddError(null);
  }, []);

  async function selectRepository(name: string) {
    await postForm("/api/git/select", { name });
    setOpen(false);
    await onRefresh();
  }

  async function addRepository(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextPath = path.trim();
    if (!isAbsolutePath(nextPath)) {
      setAddError("Please add an absolute path. Paths beginning with ~ are not expanded here.");
      return;
    }

    try {
      await postForm("/api/git/repositories", {
        name: pathName(nextPath),
        path: nextPath,
      });
      setOpen(false);
      setAddError(null);
      await onRefresh();
    } catch (caught) {
      setAddError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <div className="relative z-30" ref={containerRef}>
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

      {open ? (
        <div className="absolute right-0 top-10 w-[min(520px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-card shadow-lg">
          <div className="flex items-start gap-3 border-b border-border p-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
              <Globe2 className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">Git Projects</div>
              <div className="truncate font-mono text-xs text-muted-foreground">
                {selectedRepository?.path ?? data.git.cwd}
              </div>
            </div>
            <Badge variant="outline">{data.config.gitRepositories.length}</Badge>
          </div>

          <div className="max-h-72 overflow-auto">
            {data.config.gitRepositories.length ? (
              <div className="divide-y divide-border">
                {data.config.gitRepositories.map((repository) => {
                  const selected = repository.name === selectedRepository?.name;
                  return (
                    <button
                      className={cn(
                        "grid w-full grid-cols-[1fr_auto] items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-muted",
                        selected && "bg-muted/70",
                      )}
                      key={repository.name}
                      onClick={() => void selectRepository(repository.name)}
                      type="button"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{repository.name}</span>
                        <span className="block truncate font-mono text-xs text-muted-foreground">
                          {repository.path}
                        </span>
                      </span>
                      {selected ? <Check className="size-4" /> : null}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                No saved Git projects yet.
              </div>
            )}
          </div>

          <div className="border-t border-border bg-muted/20 p-3">
            <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
              Current Path
            </div>
            <div className="mb-4 truncate rounded-md border border-border bg-background px-3 py-2 font-mono text-xs">
              {data.git.cwd}
            </div>

            <form className="grid gap-2 sm:grid-cols-[1fr_auto]" onSubmit={addRepository}>
              <Input
                aria-label="Paste absolute path"
                onChange={(event) => {
                  setPath(event.target.value);
                  setAddError(null);
                }}
                placeholder="/Users/you/projects/app"
                value={path}
              />
              <Button type="submit">
                <Plus />
                Add {pathName(path)}
              </Button>
            </form>
            <Alert
              className={cn("mt-2 px-3 py-2 text-xs", addError ? "" : "border-dashed")}
              variant={addError ? "destructive" : "muted"}
            >
              {addError ?? "Please add an absolute path. Paths beginning with ~ are not expanded."}
            </Alert>

            <Button
              className="mt-3 w-full"
              onClick={() => {
                setDraftPath(path || data.git.cwd);
                setBrowseDialogOpen(true);
              }}
              type="button"
              variant="outline"
            >
              <FolderPlus />
              Browse folders
            </Button>
          </div>
        </div>
      ) : null}
      {browseDialogOpen ? (
        <FolderPickerDialog
          initialPath={path || data.git.cwd}
          selectedPath={draftPath}
          onCancel={() => setBrowseDialogOpen(false)}
          onSelect={setDraftPath}
          onUse={() => {
            selectPath(draftPath);
            setBrowseDialogOpen(false);
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
  initialPath,
  onCancel,
  onSelect,
  onUse,
  selectedPath,
}: {
  initialPath: string;
  onCancel: () => void;
  onSelect: (path: string) => void;
  onUse: () => void;
  selectedPath: string;
}) {
  return createPortal(
    <div className="fixed inset-0 z-[1000] grid place-items-center bg-black/35 px-4">
      <div className="w-full max-w-2xl rounded-xl border border-border bg-card p-4 shadow-xl">
        <div className="mb-3 flex items-center gap-3">
          <div className="flex size-8 items-center justify-center rounded-lg border border-border bg-background">
            <Folder className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">Choose Git Project Folder</div>
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

        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onCancel} type="button" variant="outline">
            Cancel
          </Button>
          <Button onClick={onUse} type="button">
            Use this folder
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
