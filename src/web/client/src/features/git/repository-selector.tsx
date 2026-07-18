/**
 * Shared folder-picking pieces for project management. The header repository
 * selector that used to live here was replaced by the sidebar ProjectSwitcher
 * (see project-switcher.tsx); the picker dialog remains shared with the
 * multi-repo board.
 */
import { createPortal } from "react-dom";
import { Folder, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FolderExplorer } from "./folder-explorer";

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
