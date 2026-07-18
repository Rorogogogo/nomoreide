import { type FormEvent, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronsUpDown,
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
import { FolderPickerDialog } from "./repository-selector";
import { pathName } from "./path-utils";

/**
 * Persistent project context: lives at the top of the sidebar on every page.
 * Picking a repo selects it daemon-side (git/GitHub/workflows follow it) and
 * scopes the Services / Error Inbox views; "All projects" clears the scope
 * without touching the daemon selection.
 */
export function ProjectSwitcher({
  data,
  docked,
  scopeAll,
  onScopeChange,
  onRefresh,
}: {
  data: DashboardData;
  docked: boolean;
  scopeAll: boolean;
  onScopeChange: (scopeAll: boolean) => void;
  onRefresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const selectedRepository = data.git.selectedRepository;
  const label = scopeAll
    ? "All projects"
    : selectedRepository?.name ?? "Pick a project";

  return (
    <>
      <button
        aria-label={`Project scope: ${label}`}
        className={cn(
          "relative grid h-11 grid-cols-[48px_minmax(0,1fr)] items-center overflow-hidden rounded-md border border-border bg-background/60 text-left transition-[background-color,width] duration-150 hover:bg-muted",
          docked ? "w-full" : "w-12 group-hover/sidebar:w-full",
        )}
        onClick={() => setOpen(true)}
        title={`Project scope: ${label}`}
        type="button"
      >
        <span className="flex h-11 w-12 items-center justify-center text-muted-foreground [&_svg]:size-5">
          {scopeAll ? <Globe2 /> : <Folder />}
        </span>
        <span
          className={cn(
            "min-w-0 overflow-hidden whitespace-pre pr-8 transition duration-150",
            docked
              ? "translate-x-1 opacity-100"
              : "opacity-0 group-hover/sidebar:translate-x-1 group-hover/sidebar:opacity-100",
          )}
        >
          <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Project
          </span>
          <span className="block truncate text-[13px] font-medium">{label}</span>
        </span>
        <ChevronsUpDown
          className={cn(
            "absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground transition-opacity duration-150",
            docked ? "opacity-100" : "opacity-0 group-hover/sidebar:opacity-100",
          )}
        />
      </button>
      {open ? (
        <ProjectSwitcherDialog
          data={data}
          onClose={() => setOpen(false)}
          onRefresh={onRefresh}
          onScopeChange={onScopeChange}
          scopeAll={scopeAll}
        />
      ) : null}
    </>
  );
}

function ProjectSwitcherDialog({
  data,
  onClose,
  onRefresh,
  onScopeChange,
  scopeAll,
}: {
  data: DashboardData;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onScopeChange: (scopeAll: boolean) => void;
  scopeAll: boolean;
}) {
  const [addMode, setAddMode] = useState<"path" | "url">("path");
  const [path, setPath] = useState(data.git.cwd);
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloning, setCloning] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [draftPath, setDraftPath] = useState(data.git.cwd);
  const selectedRepository = data.git.selectedRepository;
  const { error: showErrorToast, success: showSuccessToast } = useToasts();

  async function selectProject(name: string) {
    try {
      await selectGitRepository(name);
      onScopeChange(false);
      onClose();
      await onRefresh();
      showSuccessToast(`Switched to ${name}.`);
    } catch (caught) {
      showErrorToast(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function selectAllProjects() {
    onScopeChange(true);
    onClose();
    showSuccessToast("Showing all projects.");
  }

  async function registerPath(nextPath: string): Promise<boolean> {
    const trimmed = nextPath.trim();
    if (!trimmed.startsWith("/")) {
      const message =
        "Please add an absolute path. Paths beginning with ~ are not expanded here.";
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

  async function removeProject(name: string) {
    try {
      await deleteGitRepository(name);
      await onRefresh();
      showSuccessToast(`Removed Git project ${name}.`);
    } catch (caught) {
      showErrorToast(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function addFromInput(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await registerPath(path);
    if (ok) onClose();
  }

  async function addFromUrl(event: FormEvent<HTMLFormElement>) {
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
      onClose();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setAddError(message);
      showErrorToast(message);
    } finally {
      setCloning(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[1000] grid place-items-center bg-black/35 px-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-card shadow-xl">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Globe2 className="size-4 text-muted-foreground" />
          <div className="text-sm font-semibold">Projects</div>
          <Badge className="h-5 px-1.5 text-[10px]" variant="outline">
            {data.config.gitRepositories.length}
          </Badge>
          <Button
            aria-label="Close project switcher"
            className="ml-auto size-7"
            onClick={onClose}
            size="icon"
            variant="ghost"
          >
            <X className="size-4" />
          </Button>
        </div>

        <div className="max-h-80 overflow-auto">
          <button
            className={cn(
              "grid w-full grid-cols-[1fr_auto] items-center gap-2 border-b border-border px-4 py-2.5 text-left transition-colors hover:bg-muted",
              scopeAll && "bg-muted/70",
            )}
            onClick={selectAllProjects}
            type="button"
          >
            <span className="flex min-w-0 items-center gap-2">
              <Globe2 className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium leading-tight">
                  All projects
                </span>
                <span className="block truncate text-[10px] leading-tight text-muted-foreground">
                  Everything the daemon runs, across every repo
                </span>
              </span>
            </span>
            {scopeAll ? <Check className="size-3.5" /> : <span className="size-3.5" />}
          </button>

          {data.config.gitRepositories.length ? (
            <div className="divide-y divide-border">
              {data.config.gitRepositories.map((repository) => {
                const selected =
                  !scopeAll && repository.name === selectedRepository?.name;
                return (
                  <div
                    className={cn(
                      "group grid w-full grid-cols-[1fr_auto_auto] items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-muted",
                      selected && "bg-muted/70",
                    )}
                    key={repository.name}
                  >
                    <button
                      className="min-w-0 text-left"
                      onClick={() => void selectProject(repository.name)}
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
                      onClick={() => void removeProject(repository.name)}
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
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">
              No saved Git projects yet.
            </div>
          )}
        </div>

        <div className="border-t border-border bg-muted/20 p-3">
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
            <form className="flex gap-1.5" onSubmit={addFromInput}>
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
                onClick={() => {
                  setAddError(null);
                  setDraftPath(data.git.cwd);
                  setBrowseOpen(true);
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                <FolderPlus className="size-3" />
              </Button>
            </form>
          ) : (
            <form className="flex gap-1.5" onSubmit={addFromUrl}>
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
              Private github.com repos reuse your GitHub login; SSH uses your
              machine's keys. Clones into ~/.nomoreide/repos.
            </div>
          ) : null}
        </div>
      </div>
      {browseOpen ? (
        <FolderPickerDialog
          confirmLabel="Add Git project"
          errorMessage={addError}
          initialPath={data.git.cwd}
          selectedPath={draftPath}
          title="Add Git Project"
          onCancel={() => setBrowseOpen(false)}
          onSelect={setDraftPath}
          onUse={async () => {
            const ok = await registerPath(draftPath);
            if (ok) {
              setBrowseOpen(false);
              onClose();
            }
          }}
        />
      ) : null}
    </div>,
    document.body,
  );
}
