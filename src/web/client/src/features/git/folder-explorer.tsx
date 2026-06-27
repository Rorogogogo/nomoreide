import { useEffect, useState } from "react";
import { ChevronDown, Folder, Loader2 } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getDirectories, type DirectoryListing } from "@/lib/api";
import { cn } from "@/lib/utils";

export function FolderExplorer({
  initialPath,
  onSelect,
  selectedPath,
}: {
  initialPath: string;
  onSelect: (path: string) => void;
  selectedPath: string;
}) {
  const [browsePath, setBrowsePath] = useState(initialPath);
  const [pathDraft, setPathDraft] = useState(initialPath);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const canGoBack = canOpenParentFolder(listing);

  useEffect(() => {
    setBrowsePath(initialPath);
  }, [initialPath]);

  // Keep the editable field in sync with the resolved location after a jump.
  useEffect(() => {
    if (listing) setPathDraft(listing.path);
  }, [listing]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void getDirectories(browsePath)
      .then((nextListing) => {
        if (!active) return;
        setListing(nextListing);
        onSelect(nextListing.path);
      })
      .catch((caught) => {
        if (!active) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [browsePath, onSelect]);

  return (
    <div className="rounded-md border border-border bg-background">
      <div className="flex items-center gap-2 border-b border-border p-2">
        {canGoBack ? (
          <Button
            aria-label="Open parent folder"
            onClick={() => listing && setBrowsePath(listing.parent)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <ChevronDown className="rotate-90" />
          </Button>
        ) : null}
        <Input
          aria-label="Folder path"
          className="h-7 min-w-0 flex-1 font-mono text-xs"
          onChange={(event) => setPathDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              const next = pathDraft.trim();
              if (next) setBrowsePath(next);
            }
          }}
          spellCheck={false}
          value={pathDraft}
        />
        {loading ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" /> : null}
      </div>
      <div className="max-h-56 overflow-auto p-1">
        {error ? (
          <Alert variant="destructive" className="m-1">
            {error}
          </Alert>
        ) : null}
        {!error && listing?.entries.length === 0 ? (
          <Alert variant="muted" className="m-1 text-center">
            No folders here.
          </Alert>
        ) : null}
        {listing?.entries.map((entry) => (
          <Button
            className={cn(
              "h-8 w-full justify-start rounded-sm px-2 text-left",
              selectedPath === entry.path && "bg-muted",
            )}
            key={entry.path}
            onClick={() => setBrowsePath(entry.path)}
            title={entry.path}
            type="button"
            variant="ghost"
          >
            <Folder className="text-accent" />
            <span className="truncate">{entry.name}</span>
          </Button>
        ))}
      </div>
    </div>
  );
}

export function canOpenParentFolder(
  listing: Pick<DirectoryListing, "parent" | "path"> | null,
): boolean {
  return Boolean(listing && listing.parent !== listing.path);
}
