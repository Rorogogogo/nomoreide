import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Calendar, CheckCircle, ChevronDown, ChevronRight, Circle, ExternalLink, FileText, GitBranch, GitMerge, MessageSquare, User, XCircle } from "lucide-react";
import {
  getGitHubPRReviewCockpit,
  mergeGitHubPR,
  type GitHubPR,
  type GitHubPRReviewCockpit,
} from "@/lib/api";
import { DiffViewer, splitDiffByFile, type FileDiff } from "../git/diff-viewer";
import { MarkdownBody } from "./markdown-body";
import { TabStrip } from "@/components/ui/tab-strip";
import { AiContextTarget } from "../agent/context-menu/ai-context-menu";
import { buildPrAskPrompt, buildPrFileAskPrompt } from "../agent/prompts";
import { Button } from "@/components/ui/button";
import { useOperations } from "@/components/operations/operation-context";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Loading, Spinner } from "@/components/ui/loading";
import { useT } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/i18n/en";
import { cn } from "@/lib/utils";

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
  const t = useT();
  const [tab, setTab] = useState<"cockpit" | "diff">("cockpit");
  const [cockpit, setCockpit] = useState<GitHubPRReviewCockpit | null>(null);
  const [cockpitLoading, setCockpitLoading] = useState(false);
  const [cockpitError, setCockpitError] = useState<string | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [confirmingMerge, setConfirmingMerge] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const { isPending, runOperation } = useOperations();
  const mergeKey = pr ? `github:pr:${pr.number}:merge` : "";
  const merging = mergeKey ? isPending(mergeKey) : false;

  const fileDiffs = useMemo(() => splitDiffByFile(diff), [diff]);

  // Keep a valid file selected as the diff changes (PR switch, refresh).
  useEffect(() => {
    setSelectedFile((current) =>
      current && fileDiffs.some((file) => file.path === current)
        ? current
        : fileDiffs[0]?.path ?? null,
    );
  }, [fileDiffs]);

  const activeFileDiff =
    fileDiffs.find((file) => file.path === selectedFile) ?? fileDiffs[0] ?? null;

  // Jump from a Review-tab file row straight to that file's diff.
  function openFileDiff(path: string) {
    setSelectedFile(path);
    setTab("diff");
  }

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
    return <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">{t("github.pr.selectPrompt")}</div>;
  }

  const canMerge = pr.state === "open" && !pr.draft;

  async function squashMerge() {
    if (!pr || merging) return;
    setMergeError(null);
    try {
      await runOperation(
        {
          errorMessage: (error) =>
            error instanceof Error ? error.message : String(error),
          key: mergeKey,
          label: t("github.pr.mergingOperation", { number: pr.number }),
        },
        () => mergeGitHubPR(pr.number, { method: "squash" }),
      );
      setConfirmingMerge(false);
      onMerged?.();
    } catch (caught) {
      setMergeError(caught instanceof Error ? caught.message : String(caught));
      setConfirmingMerge(false);
    }
  }

  return (
    <AiContextTarget
      target={{
        label: `PR #${pr.number}`,
        intents: [{
          id: "review-pr",
          label: t("github.pr.askLabel", { number: pr.number }),
          resolvePrompt: () =>
            buildPrAskPrompt(
              pr,
              "Review this pull request, summarize the changes, and identify risks or blockers.",
            ),
          source: { type: "github-pr", label: `PR #${pr.number}` },
          agentLabel: `PR #${pr.number}: ${pr.title}`,
        }],
      }}
    >
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="group flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{pr.title}</span>
        <TabStrip
          ariaLabel={t("github.pr.tabsLabel")}
          idPrefix="github-pr"
          onSelect={setTab}
          tabs={[
            { id: "cockpit", label: t("github.pr.tabReview") },
            { id: "diff", label: t("github.pr.tabDiff") },
          ]}
          value={tab}
        />
        {canMerge ? (
          <Button
            className="shrink-0"
            loading={merging}
            loadingLabel={t("github.pr.merging")}
            onClick={() => setConfirmingMerge(true)}
            size="sm"
            title={t("github.pr.squashTitle")}
            type="button"
            variant="success"
          >
            <GitMerge />
            {t("github.pr.squashMerge")}
          </Button>
        ) : null}
        <a
          aria-label={t("github.openOnGithub")}
          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          href={pr.html_url}
          rel="noopener noreferrer"
          target="_blank"
          title={t("github.openOnGithub")}
        >
          <ExternalLink className="size-3.5" />
        </a>
      </div>
      {mergeError ? (
        <div className="shrink-0 border-b border-border bg-red-500/10 px-3 py-1.5 text-[11px] text-red-500">
          {mergeError}
        </div>
      ) : null}

      <div
        aria-labelledby={`github-pr-tab-${tab}`}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
        id={`github-pr-panel-${tab}`}
        role="tabpanel"
      >
        {tab === "cockpit" ? (
          <div className="min-h-0 flex-1 overflow-auto">
            <PRReviewCockpit
              cockpit={cockpit}
              error={cockpitError}
              loading={cockpitLoading}
              onOpenFile={openFileDiff}
              pr={pr}
            />
          </div>
        ) : diffLoading ? (
          <Loading className="flex-1" label={t("git.diff.loading")} />
        ) : diffError ? (
          <div className="p-4 text-[12px] text-red-500">{diffError}</div>
        ) : fileDiffs.length ? (
          <div className="flex min-h-0 min-w-0 flex-1">
            <FileDiffList
              files={fileDiffs}
              pr={pr}
              onSelect={setSelectedFile}
              selected={activeFileDiff?.path ?? null}
            />
            <div className="relative min-h-0 min-w-0 flex-1">
              {activeFileDiff ? <DiffViewer diff={activeFileDiff.diff} /> : null}
            </div>
          </div>
        ) : (
          <div className="p-4 text-[12px] text-muted-foreground">{t("github.pr.noDiff")}</div>
        )}
      </div>

      {confirmingMerge ? (
        <ConfirmDialog
          confirmLabel={
            merging ? (
              <>
                <Spinner size="sm" /> {t("github.pr.merging")}
              </>
            ) : (
              t("github.pr.squashMerge")
            )
          }
          icon={<GitMerge />}
          loading={merging}
          message={
            <>
              {t("github.pr.confirmPre")}<span className="font-mono">#{pr.number}</span>{" "}
              <span className="font-medium text-foreground">{pr.title}</span>{t("github.pr.confirmInto")}
              <span className="font-mono">{pr.base.ref}</span>{t("github.pr.confirmQ")}
            </>
          }
          onCancel={() => setConfirmingMerge(false)}
          onConfirm={() => void squashMerge()}
          title={t("github.pr.squashMerge")}
          tone="success"
        />
      ) : null}
    </div>
    </AiContextTarget>
  );
}

function PRReviewCockpit({
  pr,
  cockpit,
  loading,
  error,
  onOpenFile,
}: {
  pr: GitHubPR;
  cockpit: GitHubPRReviewCockpit | null;
  loading: boolean;
  error: string | null;
  onOpenFile: (path: string) => void;
}) {
  const t = useT();
  const [filesOpen, setFilesOpen] = useState(false);
  const activePR = cockpit?.pr ?? pr;
  const files = cockpit?.files ?? [];
  const reviews = cockpit?.reviews ?? [];
  const comments = cockpit?.comments ?? [];
  const checks = cockpit?.checks ?? null;
  const failingChecks = checks?.runs.filter((run) => run.conclusion === "failure" || run.conclusion === "timed_out" || run.conclusion === "cancelled") ?? [];

  return (
    // Sections are separated by a single hairline rather than each being boxed
    // in its own card. Nothing here is a bounded object — it is one continuous
    // read down the PR — so spacing and rules carry the hierarchy.
    <div className="divide-y divide-border/70">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 text-[12px]">
        <StateText pr={activePR} />
        <span className="inline-flex items-center gap-1 font-mono text-[11px]">
          <GitBranch aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
          {activePR.base.ref}
          <ArrowLeft aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
          {activePR.head.ref}
        </span>
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <User aria-hidden="true" className="size-3 shrink-0" />
          {activePR.user.login}
        </span>
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <Calendar aria-hidden="true" className="size-3 shrink-0" />
          {new Date(activePR.created_at).toLocaleDateString()}
        </span>
      </div>

      {error ? (
        <div className="px-3 py-2 text-[12px] text-red-500" role="alert">
          {error}
        </div>
      ) : null}
      {loading ? (
        <Loading className="justify-start px-3 py-2" label={t("github.pr.loadingCockpit")} />
      ) : null}

      <div className="grid gap-x-4 gap-y-2 px-3 py-2.5 sm:grid-cols-2 md:grid-cols-4">
        <CockpitMetric title={t("github.pr.mergeReadiness")} value={t(mergeReadinessKey(activePR, checks))} tone={mergeTone(activePR, checks)} />
        <CockpitMetric title={t("github.pr.reviewStateTitle")} value={t(reviewStateKey(reviews))} tone={reviewTone(reviews)} />
        <CockpitMetric title={t("github.pr.checks")} value={checks ? t("github.pr.checksValue", { state: checks.state, count: checks.totalCount }) : t("github.pr.unknown")} tone={checks?.state === "success" ? "success" : checks?.state === "failure" || checks?.state === "error" ? "danger" : "muted"} />
        <CockpitMetric title={t("github.pr.changedFiles")} value={String(files.length)} tone="muted" />
      </div>

      {failingChecks.length > 0 ? (
        <section className="px-3 py-2.5">
          <div className="mb-1 text-[10px] uppercase text-red-500">{t("github.pr.failingChecks")}</div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {failingChecks.slice(0, 4).map((check) => (
              <a
                className="inline-flex items-center gap-1 text-[11px] text-red-500 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                href={check.html_url}
                key={check.id}
                rel="noopener noreferrer"
                target="_blank"
              >
                <XCircle aria-hidden="true" className="size-3" />
                {t("github.pr.openFailingCheck", { name: check.name })}
              </a>
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <button
          aria-expanded={filesOpen}
          className="flex w-full items-center gap-2 px-3 py-2 text-[12px] font-medium transition-colors hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={() => setFilesOpen((open) => !open)}
          type="button"
        >
          {filesOpen ? (
            <ChevronDown aria-hidden="true" className="size-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
          )}
          <FileText aria-hidden="true" className="size-3.5 text-muted-foreground" />
          {t("github.pr.changedFiles")}
          {files.length ? (
            <span className="font-mono text-[11px] text-muted-foreground">({files.length})</span>
          ) : null}
        </button>
        {!filesOpen ? null : files.length ? (
          <ul className="border-t border-border/60">
            {files.slice(0, 12).map((file) => (
              <li key={file.path}>
                <button
                  className="flex w-full items-center gap-2 px-3 py-1.5 pl-8 text-left text-[12px] transition-colors hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  onClick={() => onOpenFile(file.path)}
                  title={t("github.pr.viewDiffTitle", { path: file.path })}
                  type="button"
                >
                  <span className="w-16 shrink-0 font-mono text-[10px] uppercase text-muted-foreground">{file.status}</span>
                  <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
                  <span className="shrink-0 font-mono text-[11px] text-emerald-600">+{file.additions}</span>
                  <span className="shrink-0 font-mono text-[11px] text-red-500">-{file.deletions}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-3 pb-2 pl-8 text-[12px] text-muted-foreground">{t("github.pr.noFileMeta")}</p>
        )}
      </section>

      <section>
        <div className="flex items-center gap-2 px-3 py-2 text-[12px] font-medium">
          <MessageSquare aria-hidden="true" className="size-3.5 text-muted-foreground" />
          {t("github.pr.reviewStateTitle")}
        </div>
        {reviews.length || comments.length ? (
          <div className="border-t border-border/60">
            {reviews.slice(-4).map((review) => (
              <ReviewLine
                href={review.html_url}
                key={`review:${review.id}`}
                meta={`${review.user.login} - ${review.state.toLowerCase()}`}
                text={review.body || t("github.pr.noReviewSummary")}
              />
            ))}
            {comments.slice(-4).map((comment) => (
              <ReviewLine
                href={comment.html_url}
                key={`comment:${comment.id}`}
                meta={t("github.pr.reviewMetaComment", { login: comment.user.login })}
                text={comment.body}
              />
            ))}
          </div>
        ) : (
          <p className="px-3 pb-2 text-[12px] text-muted-foreground">{t("github.pr.noReviews")}</p>
        )}
      </section>

      {activePR.body ? (
        <MarkdownBody body={activePR.body} />
      ) : (
        <p className="px-3 py-2.5 text-[12px] italic text-muted-foreground">
          {t("github.noDescription")}
        </p>
      )}
    </div>
  );
}

/** Changed-file sidebar for the Diff tab; selecting a file shows only its diff. */
function FileDiffList({
  files,
  selected,
  onSelect,
  pr,
}: {
  files: FileDiff[];
  selected: string | null;
  onSelect: (path: string) => void;
  pr: GitHubPR;
}) {
  const t = useT();
  return (
    <div className="w-44 shrink-0 overflow-y-auto border-r border-border bg-card/60">
      <ul className="py-1">
        {files.map((file) => (
          <AiContextTarget
            key={file.path}
            target={{
              label: basename(file.path),
              intents: [{
                id: "review-pr-file",
                label: t("github.pr.askFileLabel", { name: basename(file.path) }),
                resolvePrompt: () =>
                  buildPrFileAskPrompt(
                    pr,
                    file.path,
                    "Review this file's changes and identify correctness, security, or maintainability risks.",
                  ),
                source: {
                  type: "github-pr",
                  label: `PR #${pr.number} · ${basename(file.path)}`,
                },
                agentLabel: `PR #${pr.number} (${basename(file.path)}): review changes`,
              }],
            }}
          >
          <li className="group flex flex-col">
            <div
              className={cn(
                "flex items-center transition-colors",
                file.path === selected ? "bg-muted" : "hover:bg-muted/60",
              )}
            >
              <button
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px]",
                  file.path === selected ? "text-foreground" : "text-muted-foreground group-hover:text-foreground",
                )}
                onClick={() => onSelect(file.path)}
                title={file.path}
                type="button"
              >
                <span className="min-w-0 flex-1 truncate font-mono">{basename(file.path)}</span>
                <span className="shrink-0 font-mono text-[10px] text-emerald-600">+{file.additions}</span>
                <span className="shrink-0 font-mono text-[10px] text-red-500">-{file.deletions}</span>
              </button>
            </div>
          </li>
          </AiContextTarget>
        ))}
      </ul>
    </div>
  );
}

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
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
  // No card: the dot plus the label/value pair already reads as one metric.
  return (
    <div className="min-w-0">
      <div className="truncate text-[10px] uppercase text-muted-foreground">{title}</div>
      <div className="mt-0.5 flex items-center gap-1.5 text-[12px] font-medium">
        <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${dot}`} />
        <span className="min-w-0 truncate">{value}</span>
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
      className="block px-3 py-2 text-[12px] transition-colors hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      <span className="mb-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <ExternalLink aria-hidden="true" className="size-3" />
        {meta}
      </span>
      <span className="line-clamp-2 whitespace-pre-wrap">{text}</span>
    </a>
  );
}

function mergeReadinessKey(pr: GitHubPR, checks: GitHubPRReviewCockpit["checks"] | null): TranslationKey {
  if (pr.state === "merged") return "github.pr.readiness.merged";
  if (pr.state === "closed") return "github.pr.readiness.closed";
  if (pr.draft) return "github.pr.readiness.draft";
  if (pr.mergeable === false) return "github.pr.readiness.blocked";
  if (checks?.state === "failure" || checks?.state === "error") return "github.pr.readiness.checksFailing";
  if (checks?.state === "pending") return "github.pr.readiness.checksPending";
  return pr.mergeable === true ? "github.pr.readiness.ready" : "github.pr.unknown";
}

function mergeTone(pr: GitHubPR, checks: GitHubPRReviewCockpit["checks"] | null): "success" | "warning" | "danger" | "muted" {
  const readiness = mergeReadinessKey(pr, checks);
  if (readiness === "github.pr.readiness.ready") return "success";
  if (readiness === "github.pr.readiness.blocked" || readiness === "github.pr.readiness.checksFailing") return "danger";
  if (readiness === "github.pr.readiness.draft" || readiness === "github.pr.readiness.checksPending") return "warning";
  return "muted";
}

function reviewStateKey(reviews: GitHubPRReviewCockpit["reviews"]): TranslationKey {
  if (reviews.some((review) => review.state === "CHANGES_REQUESTED")) return "github.pr.review.changesRequested";
  if (reviews.some((review) => review.state === "APPROVED")) return "github.pr.review.approved";
  if (reviews.some((review) => review.state === "COMMENTED")) return "github.pr.review.commented";
  return "github.pr.review.none";
}

function reviewTone(reviews: GitHubPRReviewCockpit["reviews"]): "success" | "warning" | "danger" | "muted" {
  const state = reviewStateKey(reviews);
  if (state === "github.pr.review.approved") return "success";
  if (state === "github.pr.review.changesRequested") return "danger";
  if (state === "github.pr.review.commented") return "warning";
  return "muted";
}

function StateText({ pr }: { pr: GitHubPR }) {
  const t = useT();
  const { labelKey, dot, kind } =
    pr.state === "merged"
      ? { labelKey: "github.prState.merged" as const, dot: "bg-violet-500", kind: "merged" as const }
      : pr.state === "closed"
        ? { labelKey: "github.prState.closed" as const, dot: "bg-red-500", kind: "other" as const }
        : pr.draft
          ? { labelKey: "github.prState.draft" as const, dot: "bg-muted-foreground", kind: "other" as const }
          : { labelKey: "github.prState.open" as const, dot: "bg-emerald-500", kind: "open" as const };
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
      <span className={`size-1.5 rounded-full ${dot}`} />
      {kind === "merged" ? <GitMerge className="size-3" /> : kind === "open" ? <CheckCircle className="size-3" /> : <Circle className="size-3" />}
      {t(labelKey)}
    </span>
  );
}
