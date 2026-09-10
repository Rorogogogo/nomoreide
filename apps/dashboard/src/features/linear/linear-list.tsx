import { cn, formatUptime } from "@/lib/utils";
import { priorityEdge, priorityTone, stateTone } from "./linear-states";
import type { LinearIssue } from "./linear-types";

/**
 * The task list: DESIGN.md's row, once per issue.
 *
 * Status mark, title, one `·`-joined meta line, and nothing else. The previous
 * version put the meta line *above* the title in muted 12px and left the title
 * unstyled, which inverted the hierarchy — the eye landed on "ROR-107 · Done ·
 * Robert" before the sentence saying what the task was.
 */
export function LinearList({
  busy,
  cursor,
  emptyLabel,
  issues,
  moreLabel,
  onMore,
  onSelect,
  selectedId,
  showProject,
  t,
}: {
  busy: boolean;
  cursor: string | null;
  emptyLabel: string;
  issues: LinearIssue[];
  moreLabel: string;
  onMore: () => void;
  onSelect: (id: string) => void;
  selectedId?: string;
  /** Name each row's project — only worth it when the panel shows them all. */
  showProject?: boolean;
  t: (key: string) => string;
}) {
  if (issues.length === 0) {
    return <p className="px-3 py-4 text-[12px] text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <ul className="divide-y divide-border">
        {issues.map((issue) => (
          <li className={cn("border-l-2", priorityEdge(issue.priority))} key={issue.id}>
            <button
              className={cn(
                "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                selectedId === issue.id && "bg-muted/45",
              )}
              disabled={busy}
              onClick={() => onSelect(issue.id)}
              type="button"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center",
                  stateTone(issue.state.type),
                )}
              >
                <span className="size-1.5 rounded-full bg-current" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{issue.title}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  <span className="font-mono">{issue.identifier}</span>
                  {" · "}
                  {issue.state.name}
                  {issue.assignee ? ` · ${issue.assignee.name}` : ""}
                  {showProject && issue.project ? ` · ${issue.project.name}` : ""}
                </span>
              </span>
              {issue.priority > 0 && (
                <span className={cn("shrink-0 text-[10px]", priorityTone(issue.priority))}>
                  {t(`priority${issue.priority}`)}
                </span>
              )}
              {formatUptime(issue.updatedAt ?? undefined) && (
                <span
                  className="shrink-0 font-mono text-[10px] text-muted-foreground"
                  title={t("updated")}
                >
                  {formatUptime(issue.updatedAt ?? undefined)}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {cursor && (
        <div className="border-t border-border px-3 py-2">
          <button
            className="text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            disabled={busy}
            onClick={onMore}
            type="button"
          >
            {moreLabel}
          </button>
        </div>
      )}
    </div>
  );
}
