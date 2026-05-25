import { useEffect, useRef, useState } from "react";
import { ChevronUp, CornerDownRight, Folder, Loader2, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { getDirectories, type DirectoryListing } from "@/lib/api";
import { FileKindIcon } from "../../git/file-kind-icon";

/** Trailing extension (".txt") shown as a tag, or "" for dotless names. */
function extensionTag(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

/**
 * Browse the workspace and attach a file/folder to the agent draft without
 * leaving the dock. Lazily lists each directory (files included) via
 * `/api/fs/directories`; every entry already carries its absolute `path`, so
 * picking one hands the caller a ready-to-insert absolute path — the same
 * string a drag-and-drop produces.
 */
export function FilePicker({
  onPick,
  onClose,
}: {
  onPick: (absolutePath: string) => void;
  onClose: () => void;
}) {
  // Empty initial path → the server resolves it to the workspace root.
  const [browsePath, setBrowsePath] = useState("");
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const canGoUp = listing ? listing.parent !== listing.path : false;

  // Dismiss when focus/click leaves the popover.
  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [onClose]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void getDirectories(browsePath, { files: true })
      .then((next) => active && setListing(next))
      .catch((caught) => active && setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [browsePath]);

  return (
    <div
      ref={rootRef}
      className="absolute bottom-full left-2 z-10 mb-2 w-[22rem] max-w-[calc(100vw-1rem)] overflow-hidden rounded-md border border-border bg-card shadow-lg"
    >
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <Button
          aria-label="Parent folder"
          className="size-7"
          disabled={!canGoUp}
          onClick={() => listing && setBrowsePath(listing.parent)}
          size="icon"
          type="button"
          variant="ghost"
        >
          <ChevronUp />
        </Button>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={listing?.path}>
          {listing?.path ?? "…"}
        </span>
        {loading ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
        {listing ? (
          <Button
            className="h-7 px-2 text-[11px]"
            onClick={() => onPick(listing.path)}
            size="sm"
            title="Attach this folder"
            type="button"
            variant="outline"
          >
            <CornerDownRight /> This folder
          </Button>
        ) : null}
        <Button aria-label="Close" className="size-7" onClick={onClose} size="icon" type="button" variant="ghost">
          <X />
        </Button>
      </div>
      <div className="max-h-64 overflow-auto p-1">
        {error ? (
          <Alert variant="destructive" className="m-1">
            {error}
          </Alert>
        ) : listing && listing.entries.length === 0 ? (
          <Alert variant="muted" className="m-1 text-center">
            Empty folder.
          </Alert>
        ) : (
          listing?.entries.map((entry) => {
            const ext = entry.isDir ? "" : extensionTag(entry.name);
            return (
              <button
                key={entry.path}
                className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-[12px] hover:bg-muted"
                onClick={() => (entry.isDir ? setBrowsePath(entry.path) : onPick(entry.path))}
                title={entry.path}
                type="button"
              >
                {entry.isDir ? (
                  <Folder className="size-3.5 shrink-0 text-amber-600" />
                ) : (
                  <FileKindIcon path={entry.path} />
                )}
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {ext ? (
                  <span className="shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">
                    {ext}
                  </span>
                ) : null}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
