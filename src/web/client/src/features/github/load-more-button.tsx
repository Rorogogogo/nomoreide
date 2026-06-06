import { Loader2 } from "lucide-react";

/** Footer row for paginated GitHub lists — bumps to the next page on click. */
export function LoadMoreButton({
  hasMore,
  loading,
  onLoadMore,
}: {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}) {
  if (!hasMore) return null;
  return (
    <div className="p-2">
      <button
        className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-60"
        disabled={loading}
        onClick={onLoadMore}
        type="button"
      >
        {loading ? <Loader2 className="size-3 animate-spin" /> : null}
        {loading ? "Loading…" : "Load more"}
      </button>
    </div>
  );
}
