import { useState, type ReactNode } from "react";
import { SelectMenu } from "@/components/ui/select-menu";
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
  pending,
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
  /** The comments are still being fetched — everything else is already here. */
  pending?: boolean;
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
        {/* Shown exactly when the panel is too narrow to keep the list beside
            this — the same `@3xl/panel` threshold that collapses the split, so
            the way back can never disappear with the thing it returns to. It
            was `md:hidden`, a window measurement, which left no way back from a
            detail opened in a narrow panel on a wide screen. */}
        <button
          className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring @3xl/panel:hidden"
          onClick={onBack}
          type="button"
        >
          {t("back")}
        </button>
        <span className="font-mono text-[11px] text-muted-foreground">{issue.identifier}</span>
        <span aria-hidden="true" className="mx-1 h-3 w-px shrink-0 bg-border" />
        {/* The app's own picker, not a bare `<select>`: on macOS the native
            control renders a grey system popup that ignores the theme and the
            type scale entirely — see `select-menu.tsx`, which exists for this. */}
        <SelectMenu
          ariaLabel={t("status")}
          className="w-36"
          disabled={busy}
          onChange={(next) => {
            const state = ordered.find((entry) => entry.id === next);
            if (state) onStateChange(state);
          }}
          options={ordered.map((state) => ({
            value: state.id,
            label: state.name,
            icon: (
              <span className={cn("flex size-3 items-center justify-center", stateTone(state.type))}>
                <span className="size-1.5 rounded-full bg-current" />
              </span>
            ),
          }))}
          value={issue.state.id}
        />
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
        <div className="flex items-start justify-between gap-3 border-b border-border px-3 py-3">
          <h2 className="min-w-0 text-[13px] font-medium leading-snug">{issue.title}</h2>
          {taskAction && <span className="shrink-0">{taskAction(issue)}</span>}
        </div>

        {/* Linear descriptions are Markdown, and were being rendered as plain
            text — so a task written with headings and code fences showed its
            `##` and its backticks. Same renderer the git file viewer and the
            GitHub issue pane use, at this panel's padding rather than the file
            viewer's reading measure. */}
        {issue.description && <MarkdownPreview className="px-3 py-3" content={issue.description} />}

        {/* The one part of this pane that is not already known at click time,
            so it is the only part that gets a loading state. A spinner over the
            whole detail would hide a title, a description and a status control
            that were all available immediately. */}
        {pending && !issue.comments && (
          <>
            <div className="border-y border-border bg-muted/20 px-3 py-1">
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {t("comment")}
              </span>
            </div>
            <div aria-label={t("loading")} className="space-y-2 px-3 py-2" role="status">
              <span className="block h-2 w-24 animate-pulse rounded bg-muted" />
              <span className="block h-2 w-full animate-pulse rounded bg-muted" />
              <span className="block h-2 w-4/5 animate-pulse rounded bg-muted" />
            </div>
          </>
        )}

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
