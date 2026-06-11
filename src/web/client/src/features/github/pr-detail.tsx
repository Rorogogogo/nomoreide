import { useEffect, useState } from "react";
import { ArrowLeft, Calendar, CheckCircle, Circle, ExternalLink, FileText, GitBranch, GitMerge, Loader2, MessageSquare, User, XCircle } from "lucide-react";
import {
  getGitHubPRReviewCockpit,
  mergeGitHubPR,
  type GitHubPR,
  type GitHubPRReviewCockpit,
} from "@/lib/api";
import { DiffViewer } from "../git/diff-viewer";

export function PrDetail({
  pr,
  diff,
  diffLoading,
  diffError,
  onMerged,
}: {
  pr: GitHubPR | null;
  diff: string;
  diffLoading: boolean;
  diffError: string | null;
  onMerged?: () => void;
}) {
  const [tab, setTab] = useState<"cockpit" | "diff">("cockpit");
  const [cockpit, setCockpit] = useState<GitHubPRReviewCockpit | null>(null);
  const [cockpitLoading, setCockpitLoading] = useState(false);
  const [cockpitError, setCockpitError] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  useEffect(() => {
    if (!pr) {
      setCockpit(null);
      return;
    }
    let active = true;
    setCockpitLoading(true);
    setCockpitError(null);
    void getGitHubPRReviewCockpit(pr.number)
      .then((next) => {
        if (active) setCockpit(next);
      })
      .catch((caught) => {
        if (active) setCockpitError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (active) setCockpitLoading(false);
      });
    return () => { active = false; };
  }, [pr]);

  if (!pr) {
    return <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">Select a pull request</div>;
  }

  const canMerge = pr.state === "open" && !pr.draft;

  async function squashMerge() {
    if (!pr || merging) return;
    if (!window.confirm(`Squash & merge PR #${pr.number} "${pr.title}" into ${pr.base.ref}?`)) {
      return;
    }
    setMerging(true);
    setMergeError(null);
    try {
      await mergeGitHubPR(pr.number, { method: "squash" });
      onMerged?.();
    } catch (caught) {
      setMergeError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setMerging(false);
    }
  }

  const tabClass = (active: boolean) =>
    `rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
      active ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
    }`;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{pr.title}</span>
        <div className="flex shrink-0 items-center gap-1">
          <button className={tabClass(tab === "cockpit")} onClick={() => setTab("cockpit")} type="button">Review</button>
          <button className={tabClass(tab === "diff")} onClick={() => setTab("diff")} type="button">Diff</button>
        </div>
        {canMerge ? (
          <button
            className="flex shrink-0 items-center gap-1 rounded bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-60"
            disabled={merging}
            onClick={() => void squashMerge()}
            title="Squash & merge this pull request"
            type="button"
          >
            {merging ? <Loader2 className="size-3 animate-spin" /> : <GitMerge className="size-3" />}
            Squash &amp; merge
          </button>
        ) : null}
        <a
          aria-label="Open on GitHub"
          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          href={pr.html_url}
          rel="noopener noreferrer"
          target="_blank"
          title="Open on GitHub"
        >
          <ExternalLink className="size-3.5" />
        </a>
      </div>
      {mergeError ? (
        <div className="shrink-0 border-b border-border bg-red-500/10 px-3 py-1.5 text-[11px] text-red-500">
          {mergeError}
        </div>
      ) : null}

      {tab === "cockpit" ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <PRReviewCockpit
            cockpit={cockpit}
            error={cockpitError}
            loading={cockpitLoading}
            pr={pr}
          />
        </div>
      ) : (
        <div className="relative min-h-0 min-w-0 flex-1">
          {diffLoading ? (
            <div className="p-4 text-[12px] text-muted-foreground">Loading diff…</div>
          ) : diffError ? (
            <div className="p-4 text-[12px] text-red-500">{diffError}</div>
          ) : diff ? (
            <DiffViewer diff={diff} />
          ) : (
            <div className="p-4 text-[12px] text-muted-foreground">No diff available.</div>
          )}
        </div>
      )}
    </div>
  );
}

function PRReviewCockpit({
  pr,
  cockpit,
  loading,
  error,
}: {
  pr: GitHubPR;
  cockpit: GitHubPRReviewCockpit | null;
  loading: boolean;
  error: string | null;
}) {
  const activePR = cockpit?.pr ?? pr;
  const files = cockpit?.files ?? [];
  const reviews = cockpit?.reviews ?? [];
  const comments = cockpit?.comments ?? [];
  const checks = cockpit?.checks ?? null;
  const failingChecks = checks?.runs.filter((run) => run.conclusion === "failure" || run.conclusion === "timed_out" || run.conclusion === "cancelled") ?? [];

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[12px]">
        <StateText pr={activePR} />
        <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-[11px]">
          <GitBranch className="size-3 shrink-0 text-muted-foreground" />
          {activePR.base.ref}
          <ArrowLeft className="size-3 shrink-0 text-muted-foreground" />
          {activePR.head.ref}
        </span>
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <User className="size-3 shrink-0" />
          {activePR.user.login}
        </span>
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <Calendar className="size-3 shrink-0" />
          {new Date(activePR.created_at).toLocaleDateString()}
        </span>
      </div>

      {error ? (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-500">
          {error}
        </div>
      ) : null}
      {loading ? <p className="text-[12px] text-muted-foreground">Loading review cockpit...</p> : null}

      <div className="grid gap-2 md:grid-cols-4">
        <CockpitMetric title="Merge readiness" value={mergeReadiness(activePR, checks)} tone={mergeTone(activePR, checks)} />
        <CockpitMetric title="Review state" value={reviewState(reviews)} tone={reviewTone(reviews)} />
        <CockpitMetric title="Checks" value={checks ? `${checks.state} (${checks.totalCount})` : "unknown"} tone={checks?.state === "success" ? "success" : checks?.state === "failure" || checks?.state === "error" ? "danger" : "muted"} />
        <CockpitMetric title="Changed files" value={String(files.length)} tone="muted" />
      </div>

      {failingChecks.length > 0 ? (
        <section className="rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2">
          <div className="mb-1 text-[11px] font-medium text-red-500">Failing checks</div>
          <div className="flex flex-wrap gap-2">
            {failingChecks.slice(0, 4).map((check) => (
              <a
                className="inline-flex items-center gap-1 text-[11px] text-red-500 underline-offset-2 hover:underline"
                href={check.html_url}
                key={check.id}
                rel="noopener noreferrer"
                target="_blank"
              >
                <XCircle className="size-3" />
                Open failing check: {check.name}
              </a>
            ))}
          </div>
        </section>
      ) : null}

      <section className="rounded-md border border-border bg-muted/25 p-3">
        <div className="mb-2 flex items-center gap-2 text-[12px] font-medium">
          <FileText className="size-3.5 text-muted-foreground" />
          Changed files
        </div>
        {files.length ? (
          <ul className="divide-y divide-border">
            {files.slice(0, 12).map((file) => (
              <li className="flex items-center gap-2 py-1.5 text-[12px]" key={file.path}>
                <span className="w-16 shrink-0 font-mono text-[10px] uppercase text-muted-foreground">{file.status}</span>
                <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
                <span className="shrink-0 font-mono text-[11px] text-emerald-600">+{file.additions}</span>
                <span className="shrink-0 font-mono text-[11px] text-red-500">-{file.deletions}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-muted-foreground">No changed file metadata available.</p>
        )}
      </section>

      <section className="rounded-md border border-border bg-muted/25 p-3">
        <div className="mb-2 flex items-center gap-2 text-[12px] font-medium">
          <MessageSquare className="size-3.5 text-muted-foreground" />
          Review state
        </div>
        {reviews.length || comments.length ? (
          <div className="space-y-2">
            {reviews.slice(-4).map((review) => (
              <ReviewLine
                href={review.html_url}
                key={`review:${review.id}`}
                meta={`${review.user.login} - ${review.state.toLowerCase()}`}
                text={review.body || "No review summary."}
              />
            ))}
            {comments.slice(-4).map((comment) => (
              <ReviewLine
                href={comment.html_url}
                key={`comment:${comment.id}`}
                meta={`${comment.user.login} - comment`}
                text={comment.body}
              />
            ))}
          </div>
        ) : (
          <p className="text-[12px] text-muted-foreground">No reviews or PR comments yet.</p>
        )}
      </section>

      {activePR.body ? (
        <div className="whitespace-pre-wrap rounded-md border border-border bg-muted/25 p-3 font-mono text-[12px]">
          {activePR.body}
        </div>
      ) : (
        <p className="text-[12px] italic text-muted-foreground">No description provided.</p>
      )}
    </div>
  );
}

function CockpitMetric({
  title,
  value,
  tone,
}: {
  title: string;
  value: string;
  tone: "success" | "warning" | "danger" | "muted";
}) {
  const dot =
    tone === "success"
      ? "bg-emerald-500"
      : tone === "warning"
        ? "bg-amber-500"
        : tone === "danger"
          ? "bg-red-500"
          : "bg-muted-foreground";
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <div className="text-[10px] uppercase text-muted-foreground">{title}</div>
      <div className="mt-1 flex items-center gap-1.5 text-[12px] font-medium">
        <span className={`size-1.5 rounded-full ${dot}`} />
        {value}
      </div>
    </div>
  );
}

function ReviewLine({
  meta,
  text,
  href,
}: {
  meta: string;
  text: string;
  href: string;
}) {
  return (
    <a
      className="block rounded border border-border bg-card px-2.5 py-2 text-[12px] transition-colors hover:bg-muted/60"
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      <span className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <ExternalLink className="size-3" />
        {meta}
      </span>
      <span className="line-clamp-2 whitespace-pre-wrap">{text}</span>
    </a>
  );
}

function mergeReadiness(pr: GitHubPR, checks: GitHubPRReviewCockpit["checks"] | null): string {
  if (pr.state !== "open") return pr.state;
  if (pr.draft) return "draft";
  if (pr.mergeable === false) return "blocked";
  if (checks?.state === "failure" || checks?.state === "error") return "checks failing";
  if (checks?.state === "pending") return "checks pending";
  return pr.mergeable === true ? "ready" : "unknown";
}

function mergeTone(pr: GitHubPR, checks: GitHubPRReviewCockpit["checks"] | null): "success" | "warning" | "danger" | "muted" {
  const readiness = mergeReadiness(pr, checks);
  if (readiness === "ready") return "success";
  if (readiness === "blocked" || readiness === "checks failing") return "danger";
  if (readiness === "draft" || readiness === "checks pending") return "warning";
  return "muted";
}

function reviewState(reviews: GitHubPRReviewCockpit["reviews"]): string {
  if (reviews.some((review) => review.state === "CHANGES_REQUESTED")) return "changes requested";
  if (reviews.some((review) => review.state === "APPROVED")) return "approved";
  if (reviews.some((review) => review.state === "COMMENTED")) return "commented";
  return "no reviews";
}

function reviewTone(reviews: GitHubPRReviewCockpit["reviews"]): "success" | "warning" | "danger" | "muted" {
  const state = reviewState(reviews);
  if (state === "approved") return "success";
  if (state === "changes requested") return "danger";
  if (state === "commented") return "warning";
  return "muted";
}

function StateText({ pr }: { pr: GitHubPR }) {
  const { label, dot } =
    pr.state === "merged"
      ? { label: "Merged", dot: "bg-violet-500" }
      : pr.state === "closed"
        ? { label: "Closed", dot: "bg-red-500" }
        : pr.draft
          ? { label: "Draft", dot: "bg-muted-foreground" }
          : { label: "Open", dot: "bg-emerald-500" };
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
      <span className={`size-1.5 rounded-full ${dot}`} />
      {label === "Merged" ? <GitMerge className="size-3" /> : label === "Open" ? <CheckCircle className="size-3" /> : <Circle className="size-3" />}
      {label}
    </span>
  );
}
