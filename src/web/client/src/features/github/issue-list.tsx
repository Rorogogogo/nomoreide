import { CircleDot } from "lucide-react";
import type { GitHubIssue } from "@/lib/api";
import { IssueLabelSwatch } from "./issue-label-swatch";
import { LoadMoreButton } from "./load-more-button";

export function IssueList({
  issues,
  loading,
  loadingMore,
  hasMore,
  error,
  selectedNumber,
  onSelect,
  onLoadMore,
}: {
  issues: GitHubIssue[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  selectedNumber: number | null;
  onSelect: (number: number) => void;
  onLoadMore: () => void;
}) {
  if (loading && issues.length === 0) {
    return <div className="p-4 text-[12px] text-muted-foreground">Loading issues…</div>;
  }
  if (error) {
    return <div className="p-4 text-[12px] text-red-500">{error}</div>;
  }
  if (issues.length === 0) {
    return <div className="p-4 text-[12px] text-muted-foreground">No issues found.</div>;
  }

  return (
    <>
      <ul className="divide-y divide-border">
      {issues.map((issue) => (
        <li key={issue.number}>
          <button
            className={`flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/60 ${
              selectedNumber === issue.number ? "bg-muted" : ""
            }`}
            onClick={() => onSelect(issue.number)}
            type="button"
          >
            <CircleDot
              className={`mt-0.5 size-4 shrink-0 ${
                issue.state === "open" ? "text-emerald-500" : "text-red-500"
              }`}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">{issue.title}</span>
              <span className="block text-[11px] text-muted-foreground">
                #{issue.number} · {issue.user.login} · {issue.comments} comment{issue.comments !== 1 ? "s" : ""}
              </span>
            </span>
            {issue.labels.length > 0 ? (
              <span className="flex max-w-40 shrink-0 flex-wrap justify-end gap-x-2 gap-y-0.5">
                {issue.labels.slice(0, 3).map((label) => (
                  <IssueLabelSwatch key={label.name} label={label} />
                ))}
              </span>
            ) : null}
          </button>
        </li>
      ))}
      </ul>
      <LoadMoreButton hasMore={hasMore} loading={loadingMore} onLoadMore={onLoadMore} />
    </>
  );
}
