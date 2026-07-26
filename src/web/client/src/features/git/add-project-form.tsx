import { type FormEvent, useState } from "react";
import { Download, Folder, FolderPlus, Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToasts } from "@/components/ui/toast";
import {
  cloneGitRepository,
  createGitRepository,
  registerGitRepository,
  type DashboardData,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { pathName } from "./path-utils";
import { FolderPickerDialog } from "./repository-selector";

type AddMode = "path" | "url" | "new";

/**
 * The three ways a project comes into existence — adopt a folder you already
 * have, clone one, or create one from scratch — presented as one labelled
 * section so they read as alternatives rather than unrelated widgets.
 */
export function AddProjectForm({
  data,
  onAdded,
  onCreated,
  onRefresh,
}: {
  data: DashboardData;
  /** An existing project was adopted or cloned. */
  onAdded: () => void;
  /** A brand-new project was created; the caller decides whether to switch. */
  onCreated: (name: string) => void | Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const t = useT();
  const [addMode, setAddMode] = useState<AddMode>("path");
  const [path, setPath] = useState(data.git.cwd);
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloning, setCloning] = useState(false);
  const [newName, setNewName] = useState("");
  const [newParent, setNewParent] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  /** Which flow opened the folder picker — adopting a folder, or picking the
      parent directory for a brand-new project. */
  const [browseOpen, setBrowseOpen] = useState<"adopt" | "parent" | null>(null);
  const [draftPath, setDraftPath] = useState(data.git.cwd);
  const { error: showErrorToast, success: showSuccessToast } = useToasts();

  function fail(caught: unknown) {
    const message = caught instanceof Error ? caught.message : String(caught);
    setAddError(message);
    showErrorToast(message);
  }

  async function registerPath(nextPath: string): Promise<boolean> {
    const trimmed = nextPath.trim();
    if (!trimmed.startsWith("/")) {
      const message = t("git.repo.absPathError");
      setAddError(message);
      showErrorToast(message);
      return false;
    }
    try {
      const repoName = pathName(trimmed);
      await registerGitRepository(repoName, trimmed);
      setAddError(null);
      await onRefresh();
      showSuccessToast(t("git.repo.addedToast", { name: repoName }));
      return true;
    } catch (caught) {
      fail(caught);
      return false;
    }
  }

  async function addFromInput(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await registerPath(path)) onAdded();
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
      showSuccessToast(t("git.repo.clonedToast", { name }));
      onAdded();
    } catch (caught) {
      fail(caught);
    } finally {
      setCloning(false);
    }
  }

  async function createNewProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setAddError(null);
    try {
      const created = await createGitRepository(name, newParent ?? undefined);
      setNewName("");
      await onRefresh();
      showSuccessToast(t("git.repo.createdToast", { name: created.name }));
      await onCreated(created.name);
    } catch (caught) {
      fail(caught);
    } finally {
      setCreating(false);
    }
  }

  const modes: ReadonlyArray<[AddMode, typeof Folder, string]> = [
    ["path", Folder, t("git.repo.modeExisting")],
    ["url", Download, t("git.repo.modeClone")],
    ["new", Sparkles, t("git.repo.modeCreate")],
  ];

  return (
    <div className="shrink-0 border-t border-border bg-muted/20 p-3">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        {/* The three modes were indistinguishable while they were named after
            what they do ("Existing folder" / "Create new"). Naming them after
            the one thing that decides between them — where the code is right
            now — makes the choice answer itself. */}
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {t("git.repo.addSection")}
        </span>
        <span className="text-[11px] text-muted-foreground">{t("git.repo.addQuestion")}</span>
        <div className="flex gap-1 text-[11px]">
          {modes.map(([mode, Icon, label]) => (
            <button
              className={cn(
                "flex items-center gap-1 rounded px-2 py-0.5 transition-colors",
                addMode === mode
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              key={mode}
              onClick={() => {
                setAddMode(mode);
                setAddError(null);
              }}
              type="button"
            >
              <Icon className="size-3" />
              {label}
            </button>
          ))}
        </div>
      </div>

      {addMode === "path" ? (
        <form className="flex gap-1.5" onSubmit={addFromInput}>
          <Input
            aria-label={t("git.repo.pasteAbsPath")}
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
            {t("common.add")}
          </Button>
          <Button
            aria-label={t("git.repo.browseAdd")}
            className="h-7 px-2"
            onClick={() => {
              setAddError(null);
              setDraftPath(data.git.cwd);
              setBrowseOpen("adopt");
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            <FolderPlus className="size-3" />
          </Button>
        </form>
      ) : addMode === "new" ? (
        <form className="flex gap-1.5" onSubmit={createNewProject}>
          <Input
            aria-label={t("git.repo.createName")}
            className="h-7 flex-1 px-2 font-mono text-[11px]"
            onChange={(event) => {
              setNewName(event.target.value);
              setAddError(null);
            }}
            placeholder={t("git.repo.createNamePlaceholder")}
            value={newName}
          />
          <Button
            className="h-7 px-2 text-[11px]"
            disabled={creating || !newName.trim()}
            size="sm"
            type="submit"
          >
            <Sparkles className="size-3" />
            {creating ? t("git.repo.creating") : t("git.repo.create")}
          </Button>
          <Button
            aria-label={t("git.repo.createBrowse")}
            className="h-7 px-2"
            onClick={() => {
              setAddError(null);
              setDraftPath(newParent ?? data.git.cwd);
              setBrowseOpen("parent");
            }}
            size="sm"
            title={t("git.repo.createBrowse")}
            type="button"
            variant="outline"
          >
            <FolderPlus className="size-3" />
          </Button>
        </form>
      ) : (
        <form className="flex gap-1.5" onSubmit={addFromUrl}>
          <Input
            aria-label={t("git.repo.remoteUrl")}
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
            {cloning ? t("git.repo.cloning") : t("git.repo.clone")}
          </Button>
        </form>
      )}

      {addError ? (
        <div className="mt-1.5 truncate text-[10px] text-destructive">{addError}</div>
      ) : null}
      <div className="mt-1 text-[10px] text-muted-foreground">
        {addMode === "path" ? t("git.repo.existingHint") : null}
        {addMode === "url" ? t("git.repo.cloneHint") : null}
        {addMode === "new"
          ? newParent
            ? t("git.repo.createIn", { path: newParent })
            : t("git.repo.createHint")
          : null}
      </div>

      {browseOpen === "adopt" ? (
        <FolderPickerDialog
          confirmLabel={t("git.repo.addProject")}
          errorMessage={addError}
          initialPath={data.git.cwd}
          selectedPath={draftPath}
          title={t("git.repo.addProjectTitle")}
          onCancel={() => setBrowseOpen(null)}
          onSelect={setDraftPath}
          onUse={async () => {
            if (await registerPath(draftPath)) {
              setBrowseOpen(null);
              onAdded();
            }
          }}
        />
      ) : null}
      {browseOpen === "parent" ? (
        <FolderPickerDialog
          confirmLabel={t("git.repo.useThisFolder")}
          initialPath={newParent ?? data.git.cwd}
          selectedPath={draftPath}
          title={t("git.repo.createParentTitle")}
          onCancel={() => setBrowseOpen(null)}
          onSelect={setDraftPath}
          onUse={() => {
            setNewParent(draftPath);
            setBrowseOpen(null);
          }}
        />
      ) : null}
    </div>
  );
}
