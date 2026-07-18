import { type FormEvent, useState } from "react";
import { Check, FolderCog, FolderPlus, Globe2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToasts } from "@/components/ui/toast";
import {
  registerGitRepository,
  selectGitRepository,
  type DashboardData,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { FolderPickerDialog } from "./repository-selector";
import { pathName } from "./path-utils";

/**
 * Inline project list, disclosed under the sidebar trigger (no popover — it
 * expands in place and pushes the nav down). Switching and adding (paste a
 * path or browse) happen here; clone-from-URL and deleting stay behind
 * "Manage projects…" (the dialog). Rows follow the nav buttons'
 * collapsed-rail pattern: 48px icon column, labels fade in when the rail is
 * docked or hovered.
 */
export function ProjectMenuList({
  data,
  docked,
  scopeAll,
  onScopeChange,
  onRefresh,
  onClose,
  onManage,
}: {
  data: DashboardData;
  docked: boolean;
  scopeAll: boolean;
  onScopeChange: (scopeAll: boolean) => void;
  onRefresh: () => Promise<void>;
  onClose: () => void;
  onManage: () => void;
}) {
  const { error: showErrorToast, success: showSuccessToast } = useToasts();
  const selectedRepository = data.git.selectedRepository;
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState(data.git.cwd);
  const [addError, setAddError] = useState<string | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [draftPath, setDraftPath] = useState(data.git.cwd);

  async function selectProject(name: string) {
    onClose();
    try {
      await selectGitRepository(name);
      onScopeChange(false);
      await onRefresh();
      showSuccessToast(`Switched to ${name}.`);
    } catch (caught) {
      showErrorToast(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function selectAllProjects() {
    onClose();
    onScopeChange(true);
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

  async function addFromInput(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await registerPath(path);
    // Keep the list open so the new row is visible right away.
    if (ok) setAdding(false);
  }

  const rowClassName = (active: boolean) =>
    cn(
      "grid h-8 grid-cols-[48px_minmax(0,1fr)] items-center overflow-hidden rounded-md text-left transition-[background-color,width] duration-150 hover:bg-muted",
      docked ? "w-full" : "w-12 group-hover/sidebar:w-full",
      active && "bg-muted/60",
    );
  const labelClassName = cn(
    "flex min-w-0 items-center gap-2 overflow-hidden whitespace-pre pr-2 text-xs transition duration-150",
    docked
      ? "translate-x-1 opacity-100"
      : "opacity-0 group-hover/sidebar:translate-x-1 group-hover/sidebar:opacity-100",
  );

  return (
    <div className="mt-1 grid gap-0.5">
      <button
        className={rowClassName(scopeAll)}
        onClick={selectAllProjects}
        title="All projects"
        type="button"
      >
        <span className="flex h-8 w-12 items-center justify-center">
          <Globe2 className="size-4 text-muted-foreground" />
        </span>
        <span className={labelClassName}>
          <span className="min-w-0 flex-1 truncate font-medium">All projects</span>
          {scopeAll ? <Check className="size-3.5 shrink-0" /> : null}
        </span>
      </button>

      {data.config.gitRepositories.map((repository) => {
        const selected = !scopeAll && repository.name === selectedRepository?.name;
        return (
          <button
            className={rowClassName(selected)}
            key={repository.name}
            onClick={() => void selectProject(repository.name)}
            title={repository.path}
            type="button"
          >
            <span aria-hidden className="h-8 w-12" />
            <span className={labelClassName}>
              <span className="min-w-0 flex-1 truncate font-medium">{repository.name}</span>
              {selected ? <Check className="size-3.5 shrink-0" /> : null}
            </span>
          </button>
        );
      })}

      <button
        className={cn(
          "grid h-8 grid-cols-[48px_minmax(0,1fr)] items-center overflow-hidden rounded-md text-left text-muted-foreground transition-[background-color,color,width] duration-150 hover:bg-muted hover:text-foreground",
          docked ? "w-full" : "w-12 group-hover/sidebar:w-full",
          adding && "bg-muted/60 text-foreground",
        )}
        onClick={() => {
          setAddError(null);
          setAdding((value) => !value);
        }}
        title="Add project"
        type="button"
      >
        <span className="flex h-8 w-12 items-center justify-center">
          <Plus className="size-4" />
        </span>
        <span className={labelClassName}>
          <span className="min-w-0 flex-1 truncate">Add project…</span>
        </span>
      </button>

      {adding ? (
        <div
          className={cn(
            "overflow-hidden transition-[width,opacity] duration-150",
            docked
              ? "w-full opacity-100"
              : "w-12 opacity-0 group-hover/sidebar:w-full group-hover/sidebar:opacity-100",
          )}
        >
          <form className="flex items-center gap-1 px-1 py-0.5" onSubmit={addFromInput}>
            <Input
              aria-label="Paste absolute path"
              autoFocus
              className="h-7 min-w-0 flex-1 px-2 font-mono text-[11px]"
              onChange={(event) => {
                setPath(event.target.value);
                setAddError(null);
              }}
              placeholder="/absolute/path"
              value={path}
            />
            <Button aria-label="Add this path" className="h-7 px-2" size="sm" type="submit">
              <Plus className="size-3" />
            </Button>
            <Button
              aria-label="Browse for a Git project"
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
          {addError ? (
            <div className="truncate px-2 pb-1 text-[10px] text-destructive">{addError}</div>
          ) : null}
        </div>
      ) : null}

      <button
        className={cn(
          "grid h-8 grid-cols-[48px_minmax(0,1fr)] items-center overflow-hidden rounded-md text-left text-muted-foreground transition-[background-color,color,width] duration-150 hover:bg-muted hover:text-foreground",
          docked ? "w-full" : "w-12 group-hover/sidebar:w-full",
        )}
        onClick={() => {
          onClose();
          onManage();
        }}
        title="Manage projects (clone from URL, remove)"
        type="button"
      >
        <span className="flex h-8 w-12 items-center justify-center">
          <FolderCog className="size-4" />
        </span>
        <span className={labelClassName}>
          <span className="min-w-0 flex-1 truncate">Manage projects…</span>
        </span>
      </button>

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
              setAdding(false);
            }
          }}
        />
      ) : null}
    </div>
  );
}
