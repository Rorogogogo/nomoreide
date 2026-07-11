import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import type { GitHubComment, GitHubIssue } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Loading, Spinner } from "@/components/ui/loading";
import { cn } from "@/lib/utils";
import { AiAskInline } from "../agent/ai-ask-inline";
import { AiSpark } from "../agent/ai-spark";
import { useAgentDock } from "../agent/chat/agent-context";
import { buildIssueAskPrompt } from "../agent/prompts";
import { MarkdownBody } from "./markdown-body";
import { MarkdownPreview } from "../git/visualizers/markdown-preview";
import { IssueLabelSwatch } from "./issue-label-swatch";
import { NotchedCommentBox } from "./notched-comment-box";

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
  const [asking, setAsking] = useState(false);
  const { sendToAgent } = useAgentDock();

  useEffect(() => {
    setAsking(false);
  }, [issue?.number]);

  function askAgent(input: string) {
    if (!issue) return;
    setAsking(false);
    sendToAgent({
      prompt: buildIssueAskPrompt(issue, input),
      source: { type: "github-issue", label: `Issue #${issue.number}` },
      label: `Issue #${issue.number}: ${input}`,
    });
  }

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
      <div className="group flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{issue.title}</span>
        <AiSpark
          className={cn("shrink-0", asking && "opacity-100")}
          label={`Ask AI about issue #${issue.number}`}
          onAsk={() => setAsking((open) => !open)}
        />
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
      {asking ? (
        <div className="shrink-0 border-b border-border px-3 py-1.5">
          <AiAskInline
            placeholder="What should the agent do with this issue? (summarize, draft a fix plan, reproduce…)"
            onSubmit={askAgent}
            onCancel={() => setAsking(false)}
          />
        </div>
      ) : null}

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
            <MarkdownBody body={issue.body} />
          ) : (
            <p className="text-[12px] text-muted-foreground italic">No description provided.</p>
          )}

          {commentsLoading ? (
            <Loading className="justify-start" label="Loading comments…" />
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
                  <MarkdownPreview content={comment.body} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-border p-3">
        <form className="flex flex-col gap-2" onSubmit={(e) => void handleSubmit(e)}>
          <NotchedCommentBox
            action={
              <Button disabled={!draft.trim() || submitting} size="sm" type="submit">
                {submitting ? (
                  <>
                    <Spinner size="sm" /> Posting…
                  </>
                ) : (
                  "Comment"
                )}
              </Button>
            }
            onChange={setDraft}
            placeholder="Add a comment…"
            value={draft}
          />
          {commentError ? <Alert variant="destructive">{commentError}</Alert> : null}
        </form>
      </div>
    </div>
  );
}
