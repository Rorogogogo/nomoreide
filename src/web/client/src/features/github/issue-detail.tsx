import { useState } from "react";
import { ExternalLink } from "lucide-react";
import type { GitHubComment, GitHubIssue } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { IssueLabelSwatch } from "./issue-label-swatch";

export function IssueDetail({
  issue,
  comments,
  commentsLoading,
  commentError,
  submitting,
  onAddComment,
}: {
  issue: GitHubIssue | null;
  comments: GitHubComment[];
  commentsLoading: boolean;
  commentError: string | null;
  submitting: boolean;
  onAddComment: (body: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");

  if (!issue) {
    return <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">Select an issue</div>;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    await onAddComment(trimmed);
    setDraft("");
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{issue.title}</span>
        <a
          aria-label="Open on GitHub"
          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          href={issue.html_url}
          rel="noopener noreferrer"
          target="_blank"
        >
          <ExternalLink className="size-3.5" />
        </a>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px]">
            <span className="text-[11px]">
              <span className="text-muted-foreground">Author: </span>
              <span className="font-medium">{issue.user.login}</span>
            </span>
            <span className="text-[11px]">
              <span className="text-muted-foreground">Opened: </span>
              <span className="font-medium">{new Date(issue.created_at).toLocaleDateString()}</span>
            </span>
            {issue.labels.map((label) => (
              <IssueLabelSwatch key={label.name} label={label} />
            ))}
          </div>

          {issue.body ? (
            <div className="whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 font-mono text-[12px]">
              {issue.body}
            </div>
          ) : (
            <p className="text-[12px] text-muted-foreground italic">No description provided.</p>
          )}

          {commentsLoading ? (
            <p className="text-[12px] text-muted-foreground">Loading comments…</p>
          ) : (
            <div className="space-y-2">
              {comments.map((comment) => (
                <div key={comment.id} className="rounded-md border border-border bg-muted/20 p-3">
                  <div className="mb-1 flex items-baseline gap-2">
                    <span className="text-[11px] font-semibold">{comment.user.login}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {new Date(comment.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap font-mono text-[12px]">{comment.body}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-border p-3">
        <form className="flex flex-col gap-2" onSubmit={(e) => void handleSubmit(e)}>
          <textarea
            className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 font-mono text-[12px] placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a comment…"
            rows={3}
            value={draft}
          />
          {commentError ? <Alert variant="destructive">{commentError}</Alert> : null}
          <Button
            className="self-end"
            disabled={!draft.trim() || submitting}
            size="sm"
            type="submit"
          >
            {submitting ? "Posting…" : "Comment"}
          </Button>
        </form>
      </div>
    </div>
  );
}
