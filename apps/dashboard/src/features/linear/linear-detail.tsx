import { useState, type ReactNode } from "react";
import { MarkdownPreview } from "../git/visualizers/markdown-preview";
import { orderStates, stateTone } from "./linear-states";
import { cn } from "@/lib/utils";
import type { LinearIssue, LinearState } from "./linear-types";

/**
 * One task, opened.
 *
 * The status control here is why the board's drag is an accelerator rather than
 * a requirement: every move a drag can make is also reachable from this select,
 * with a keyboard.
 */
export function LinearDetail({
  busy,
  issue,
  onBack,
  onComment,
  onStateChange,
  states,
  t,
  taskAction,
  trailing,
}: {
  busy: boolean;
  issue: LinearIssue;
  onBack: () => void;
  onComment: (body: string) => Promise<boolean>;
  onStateChange: (state: LinearState) => void;
  states: LinearState[];
  t: (key: string) => string;
  taskAction?: (issue: LinearIssue) => ReactNode;
  /** An extra control for the header strip — the dialog's close button. */
  trailing?: ReactNode;
}) {
  const [comment, setComment] = useState("");
  const ordered = orderStates(states);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1">
        <button
          className="text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
          onClick={onBack}
          type="button"
        >
          {t("back")}
        </button>
        <span className="font-mono text-[11px] text-muted-foreground">{issue.identifier}</span>
        <span aria-hidden="true" className="mx-1 h-3 w-px shrink-0 bg-border" />
        <select
          aria-label={t("status")}
          className={cn(
            "rounded bg-transparent px-1 py-0.5 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
            stateTone(issue.state.type),
          )}
          disabled={busy}
          onChange={(event) => {
            const next = ordered.find((state) => state.id === event.target.value);
            if (next) onStateChange(next);
          }}
          value={issue.state.id}
        >
          {ordered.map((state) => (
            <option key={state.id} value={state.id}>
              {state.name}
            </option>
          ))}
        </select>
        <span className="flex-1" />
        {/* Only ever a linear.app URL — the field is checked before it becomes
            an href, so a hostile `url` in an API answer cannot become a link. */}
        <a
          className="text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          href={issue.url.startsWith("https://linear.app/") ? issue.url : undefined}
          rel="noreferrer"
          target="_blank"
        >
          {t("open")}
        </a>
        {trailing}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex items-start justify-between gap-3 px-3 py-2.5">
          <h2 className="text-[13px] font-medium">{issue.title}</h2>
          {taskAction && <span className="shrink-0">{taskAction(issue)}</span>}
        </div>

        {/* Linear descriptions are Markdown, and were being rendered as plain
            text — so a task written with headings and code fences showed its
            `##` and its backticks. Same renderer the git file viewer and the
            GitHub issue pane use, at this panel's padding rather than the file
            viewer's reading measure. */}
        {issue.description && <MarkdownPreview className="px-3 pb-3" content={issue.description} />}

        {issue.comments && issue.comments.nodes.length > 0 && (
          <>
            <div className="border-y border-border bg-muted/20 px-3 py-1">
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {t("comment")}
              </span>
            </div>
            <ul className="divide-y divide-border">
              {issue.comments.nodes.map((entry) => (
                <li className="px-3 py-2" key={entry.id}>
                  <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">
                    {entry.user?.name}
                  </span>
                  <MarkdownPreview className="" content={entry.body} />
                </li>
              ))}
            </ul>
            {issue.comments.pageInfo.hasNextPage && (
              <p className="px-3 py-2 text-[11px] text-muted-foreground">{t("moreComments")}</p>
            )}
          </>
        )}
      </div>

      <form
        className="flex items-center gap-2 border-t border-border px-3 py-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          void onComment(comment).then((saved) => {
            if (saved) setComment("");
          });
        }}
      >
        <input
          aria-label={t("comment")}
          className="min-w-0 flex-1 bg-transparent text-[11px] placeholder:text-muted-foreground focus-visible:outline-none"
          maxLength={16000}
          onChange={(event) => setComment(event.target.value)}
          placeholder={t("comment")}
          required
          value={comment}
        />
        <button
          className="shrink-0 text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          disabled={!comment.trim() || busy}
          type="submit"
        >
          {t("send")}
        </button>
      </form>
    </div>
  );
}
