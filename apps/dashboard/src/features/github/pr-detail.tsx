import { useEffect, useMemo, useState } from "react";
import { ExternalLink, GitMerge } from "lucide-react";
import {
  getGitHubPRReviewCockpit,
  mergeGitHubPR,
  type GitHubPR,
  type GitHubPRReviewCockpit,
} from "@/lib/api";
import { DiffViewer, splitDiffByFile } from "../git/diff-viewer";
import { FileDiffList, PRReviewCockpit } from "./pr-review-cockpit";
import { TabStrip } from "@/components/ui/tab-strip";
import { AiContextTarget } from "../agent/context-menu/ai-context-menu";
import { buildPrAskPrompt } from "../agent/prompts";
import { Button } from "@/components/ui/button";
import { useOperations } from "@/components/operations/operation-context";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Loading, Spinner } from "@/components/ui/loading";
import { useT } from "@/lib/i18n";

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
