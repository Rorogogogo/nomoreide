import { useEffect, useState } from "react";
import { ChevronDown, Folder, Loader2 } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setBrowsePath(initialPath);
  }, [initialPath]);

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
        <Button
          aria-label="Open parent folder"
          disabled={!listing || listing.parent === listing.path}
          onClick={() => listing && setBrowsePath(listing.parent)}
          size="icon"
          type="button"
          variant="ghost"
        >
          <ChevronDown className="rotate-90" />
        </Button>
        <div className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {listing?.path ?? browsePath}
        </div>
        {loading ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
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
