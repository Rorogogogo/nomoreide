import { useState } from "react";
import { createGitHubPR } from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useGitHubToken } from "./hooks/use-github-token";
import { useGitHubPRs } from "./hooks/use-github-prs";
import { useGitHubIssues } from "./hooks/use-github-issues";
import { GitHubTokenSetup } from "./github-token-setup";
import { PrList } from "./pr-list";
import { PrDetail } from "./pr-detail";
import { IssueList } from "./issue-list";
import { IssueDetail } from "./issue-detail";
import { ActionsView } from "./actions-view";

type GithubTab = "prs" | "issues" | "actions";

export function GitHubView() {
  const { configured, loading: tokenLoading, refresh: refreshToken } = useGitHubToken();

  if (tokenLoading) {
    return <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">Loading…</div>;
  }

  if (!configured) {
    return <GitHubTokenSetup onSaved={refreshToken} />;
  }

  return <GitHubContent />;
}

function GitHubContent() {
  const [tab, setTab] = useState<GithubTab>("prs");
  const [prState, setPrState] = useState<"open" | "closed">("open");
  const [issueState, setIssueState] = useState<"open" | "closed">("open");
  const [showCreatePR, setShowCreatePR] = useState(false);

  const prHook = useGitHubPRs(prState);
  const issueHook = useGitHubIssues(issueState);

  const tabButtonClass = (active: boolean) =>
    `rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
      active ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
    }`;

  const stateButtonClass = (active: boolean) =>
    `rounded px-1.5 py-px text-[10px] transition-colors ${
      active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
    }`;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <div className="flex items-center gap-1">
          <button className={tabButtonClass(tab === "prs")} onClick={() => setTab("prs")} type="button">
            Pull Requests
          </button>
          <button className={tabButtonClass(tab === "issues")} onClick={() => setTab("issues")} type="button">
            Issues
          </button>
          <button className={tabButtonClass(tab === "actions")} onClick={() => setTab("actions")} type="button">
            Actions
          </button>
        </div>

        {tab === "prs" ? (
          <div className="flex items-center gap-1 ml-auto">
            <button className={stateButtonClass(prState === "open")} onClick={() => setPrState("open")} type="button">Open</button>
            <button className={stateButtonClass(prState === "closed")} onClick={() => setPrState("closed")} type="button">Closed</button>
            <Button className="ml-1" onClick={() => setShowCreatePR(true)} size="sm" type="button" variant="outline">
              New PR
            </Button>
          </div>
        ) : tab === "issues" ? (
          <div className="flex items-center gap-1 ml-auto">
            <button className={stateButtonClass(issueState === "open")} onClick={() => setIssueState("open")} type="button">Open</button>
            <button className={stateButtonClass(issueState === "closed")} onClick={() => setIssueState("closed")} type="button">Closed</button>
          </div>
        ) : null}
      </div>

      {showCreatePR ? (
        <CreatePRForm
          onCreated={() => { setShowCreatePR(false); prHook.refresh(); }}
          onCancel={() => setShowCreatePR(false)}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden">
          {tab === "prs" ? (
            <div className="grid h-full min-h-0 grid-cols-2 divide-x divide-border">
              <div className="min-h-0 overflow-auto">
                <PrList
                  error={prHook.error}
                  loading={prHook.loading}
                  onSelect={prHook.setSelectedNumber}
                  prs={prHook.prs}
                  selectedNumber={prHook.selectedNumber}
                />
              </div>
              <PrDetail
                diff={prHook.diff}
                diffError={prHook.diffError}
                diffLoading={prHook.diffLoading}
                pr={prHook.selectedPR}
              />
            </div>
          ) : tab === "issues" ? (
            <div className="grid h-full min-h-0 grid-cols-2 divide-x divide-border">
              <div className="min-h-0 overflow-auto">
                <IssueList
                  error={issueHook.error}
                  issues={issueHook.issues}
                  loading={issueHook.loading}
                  onSelect={issueHook.setSelectedNumber}
                  selectedNumber={issueHook.selectedNumber}
                />
              </div>
              <IssueDetail
                commentError={issueHook.commentError}
                comments={issueHook.comments}
                commentsLoading={issueHook.commentsLoading}
                issue={issueHook.selectedIssue}
                onAddComment={issueHook.addComment}
                submitting={issueHook.submitting}
              />
            </div>
          ) : (
            <ActionsView />
          )}
        </div>
      )}
    </div>
  );
}

function CreatePRForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [head, setHead] = useState("");
  const [base, setBase] = useState("main");
  const [draft, setDraft] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !head.trim() || !base.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await createGitHubPR({ title: title.trim(), body: body.trim() || undefined, head: head.trim(), base: base.trim(), draft });
      onCreated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  }

  const fieldClass = "w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring";

  return (
    <form className="flex flex-col gap-3 overflow-auto p-4" onSubmit={(e) => void handleSubmit(e)}>
      <h3 className="text-[13px] font-semibold">New Pull Request</h3>
      <input className={fieldClass} onChange={(e) => setTitle(e.target.value)} placeholder="Title" required value={title} />
      <div className="grid grid-cols-2 gap-2">
        <input className={fieldClass} onChange={(e) => setHead(e.target.value)} placeholder="Head branch" required value={head} />
        <input className={fieldClass} onChange={(e) => setBase(e.target.value)} placeholder="Base branch (e.g. main)" required value={base} />
      </div>
      <textarea
        className={`${fieldClass} resize-none`}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Description (optional)"
        rows={5}
        value={body}
      />
      <label className="flex items-center gap-2 text-[12px]">
        <input checked={draft} className="size-3.5" onChange={(e) => setDraft(e.target.checked)} type="checkbox" />
        Create as draft
      </label>
      {error ? <Alert variant="destructive">{error}</Alert> : null}
      <div className="flex gap-2">
        <Button disabled={submitting} type="submit">{submitting ? "Creating…" : "Create PR"}</Button>
        <Button onClick={onCancel} type="button" variant="outline">Cancel</Button>
      </div>
    </form>
  );
}
