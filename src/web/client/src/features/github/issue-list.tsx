import { CircleDot } from "lucide-react";
import type { GitHubIssue } from "@/lib/api";

export function IssueList({
  issues,
  loading,
  error,
  selectedNumber,
  onSelect,
}: {
  issues: GitHubIssue[];
  loading: boolean;
  error: string | null;
  selectedNumber: number | null;
  onSelect: (number: number) => void;
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
              <span className="flex shrink-0 flex-wrap gap-1">
                {issue.labels.slice(0, 3).map((label) => (
                  <span
                    key={label.name}
                    className="rounded-full px-1.5 py-px text-[10px] font-medium text-white"
                    style={{ backgroundColor: `#${label.color}` }}
                  >
                    {label.name}
                  </span>
                ))}
              </span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
}
