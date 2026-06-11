import type { GitHubIssue } from "@/lib/api";

type GitHubIssueLabel = GitHubIssue["labels"][number];

export function IssueLabelSwatch({ label }: { label: GitHubIssueLabel }) {
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5 text-[10px] font-medium text-muted-foreground"
      title={label.name}
    >
      <span
        className="size-2 shrink-0 rounded-sm"
        style={{ backgroundColor: `#${label.color}` }}
      />
      <span className="truncate">{label.name}</span>
    </span>
  );
}
