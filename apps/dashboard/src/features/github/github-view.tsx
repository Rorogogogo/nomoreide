import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Loading } from "@/components/ui/loading";
import { useRegisterRefresh } from "@/components/refresh-registry";
import { usePersistentState } from "@/lib/use-persistent-state";
import { useT, type TranslationKey } from "@/lib/i18n";
import { GitHubScopeContext } from "./github-cache";
import { useGitHubToken } from "./hooks/use-github-token";
import { useGitHubPRs } from "./hooks/use-github-prs";
import { useGitHubIssues } from "./hooks/use-github-issues";
import {
  consumeGitHubTokenSetupRequest,
  subscribeToGitHubActions,
  subscribeToGitHubTokenSetup,
  type GitHubSetupMode,
} from "./github-navigation";
import { GitHubConnectionRecovery } from "./github-connection-recovery";
import { BranchToPRAssistant } from "./branch-to-pr-assistant";
import { GitHubTokenSetup } from "./github-token-setup";
import { GitHubRepoAccessNotice } from "./github-repo-access";
import { StateFilter, TabStrip } from "@/components/ui/tab-strip";
import { PrList } from "./pr-list";
import { PrDetail } from "./pr-detail";
import { IssueList } from "./issue-list";
import { IssueDetail } from "./issue-detail";
import { ActionsView } from "./actions-view";
import { BranchesView } from "./branches-view";

const TABS = [
  { id: "prs", labelKey: "github.tab.prs" },
  { id: "issues", labelKey: "github.tab.issues" },
  { id: "branches", labelKey: "github.tab.branches" },
  { id: "actions", labelKey: "github.tab.actions" },
] as const satisfies readonly { id: string; labelKey: TranslationKey }[];

type GithubTab = (typeof TABS)[number]["id"];

export function GitHubView({ scope = "" }: { scope?: string }) {
  // Every GitHub request resolves against the daemon's selected repository, and
  // the cache backing these views outlives the remount a project switch causes.
  // Publishing the scope here is what keeps those cache keys apart.
  return (
    <GitHubScopeContext.Provider value={scope}>
      <GitHubViewContent />
    </GitHubScopeContext.Provider>
  );
}

function GitHubViewContent() {
  const t = useT();
  const token = useGitHubToken();
  /** A sign-in flow opened over a working connection: "Use a token with
      access", or the header account menu's "Sign in with GitHub" / "Add a
      personal access token", which navigate here and latch the request. */
  const [forceSetup, setForceSetup] = useState<GitHubSetupMode | null>(null);

  useEffect(() => {
    const pending = consumeGitHubTokenSetupRequest();
    if (pending) setForceSetup(pending);
    return subscribeToGitHubTokenSetup(() => {
      setForceSetup(consumeGitHubTokenSetupRequest() ?? "pat");
    });
  }, []);

  let content: React.ReactNode;
  if (token.loading || token.status === "checking") {
    content = <Loading fill label={t("common.loading")} />;
  } else if (forceSetup) {
    content = (
      <GitHubTokenSetup
        deviceFlowAvailable={token.deviceFlowAvailable}
        info={token.info}
        initialMode={forceSetup}
        onCancel={() => setForceSetup(null)}
        onSaved={() => {
          setForceSetup(null);
          token.refresh();
        }}
      />
    );
  } else if (token.status === "not_configured") {
    content = (
      <GitHubTokenSetup
        deviceFlowAvailable={token.deviceFlowAvailable}
        info={token.info}
        onSaved={token.refresh}
      />
    );
  } else if (token.status === "repo_access" && token.info) {
    content = (
      <GitHubRepoAccessNotice
        info={token.info}
        onRefresh={token.refresh}
        onUseToken={() => setForceSetup("pat")}
      />
    );
  } else if (token.status === "auth_error" || token.status === "connection_error") {
    content = <GitHubConnectionRecovery token={token} />;
  } else {
    content = <GitHubContent />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {content}
    </div>
  );
}

function GitHubContent() {
  const t = useT();
  // Sticky so returning to GitHub lands on the tab you left, not back on PRs.
  const [storedTab, setTab] = usePersistentState<GithubTab>("github:tab", "prs");
  // A tab id that no longer exists can still be sitting in localStorage from an
  // earlier build; without this it matches no branch below and the page falls
  // through to the last one with nothing selected in the strip.
  const tab = TABS.some((entry) => entry.id === storedTab) ? storedTab : "prs";
  const [prState, setPrState] = usePersistentState<"open" | "closed">(
    "github:pr-state",
    "open",
  );
  const [issueState, setIssueState] = usePersistentState<"open" | "closed">(
    "github:issue-state",
    "open",
  );
  const [createPRHead, setCreatePRHead] = useState<string | null>(null);
  const [actionsBranch, setActionsBranch] = usePersistentState<string | null>(
    "github:actions-branch",
    null,
  );
  const prHook = useGitHubPRs(prState);
  const issueHook = useGitHubIssues(issueState);
  // Branches/Actions own their data, but their row count belongs on the tab
  // row rather than in a second header bar under it. Only one of them is
  // mounted at a time, so a single slot is enough — cleared on tab change so a
  // stale count never sits over a view that hasn't loaded yet.
  const [tabCount, setTabCount] = useState<number | null>(null);
  useEffect(() => setTabCount(null), [tab]);

  useEffect(
    () =>
      subscribeToGitHubActions((intent) => {
        setActionsBranch(intent.branch);
        setTab("actions");
      }),
    [setActionsBranch, setTab],
  );

  // Header Refresh / the 5s dashboard poll reloads the active tab's data.
  // Branches/Actions own their own hooks in nested components and register
  // their own handler from there, so we deliberately do nothing for them here.
  // (Re-validating the token on every poll would flip the whole view to
  // "checking" every 5s — the disturbing flicker on the Actions tab.)
  useRegisterRefresh(() => {
    if (tab === "prs") prHook.refresh();
    else if (tab === "issues") issueHook.refresh();
  });

  const stateOptions = [
    { id: "open", label: t("github.open") },
    { id: "closed", label: t("github.closed") },
  ] as const;

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card/75 px-3 py-1">
        <TabStrip
          ariaLabel={t("github.tabs.label")}
          idPrefix="github"
          onSelect={setTab}
          tabs={TABS.map((entry) => ({ id: entry.id, label: t(entry.labelKey) }))}
          value={tab}
        />

        {/* No connection/account identity here: the header's GitHub indicator
            owns it, menu included. The credential is stored per repository, so
            it belongs beside the project crumb — and switching accounts or
            adding a token shouldn't require navigating to this page first. */}
        <div className="ml-auto" />

        {tab === "prs" ? (
          <div className="flex shrink-0 items-center gap-2">
            <StateFilter
              ariaLabel={t("github.filter.prState")}
              onChange={setPrState}
              options={stateOptions}
              value={prState}
            />
            <Button onClick={() => setCreatePRHead("")} size="sm" type="button" variant="outline">
              {t("github.newPr")}
            </Button>
          </div>
        ) : tab === "issues" ? (
          <StateFilter
            ariaLabel={t("github.filter.issueState")}
            onChange={setIssueState}
            options={stateOptions}
            value={issueState}
          />
        ) : (
          <div className="flex min-w-0 shrink items-center gap-2">
            {tab === "actions" && actionsBranch ? (
              <span className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
                <span className="shrink-0">{t("github.actions.filteredTo")}</span>
                <span className="min-w-0 truncate font-mono">{actionsBranch}</span>
                <button
                  aria-label={t("github.actions.clearFilter")}
                  className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => setActionsBranch(null)}
                  title={t("github.actions.clearFilter")}
                  type="button"
                >
                  <X aria-hidden="true" className="size-3" />
                </button>
              </span>
            ) : null}
            {tabCount === null ? null : (
              <span
                aria-live="polite"
                className="shrink-0 font-mono text-[9px] tabular-nums text-muted-foreground"
              >
                {tab === "branches"
                  ? t(tabCount === 1 ? "github.branches.countOne" : "github.branches.count", {
                      count: String(tabCount),
                    })
                  : t(tabCount === 1 ? "github.actions.runCountOne" : "github.actions.runCount", {
                      count: String(tabCount),
                    })}
              </span>
            )}
          </div>
        )}
      </div>

      {createPRHead !== null ? (
        <BranchToPRAssistant
          initialHead={createPRHead}
          onCreated={(created) => {
            setCreatePRHead(null);
            setTab("prs");
            prHook.setSelectedNumber(created.number);
            prHook.refresh();
          }}
          onCancel={() => setCreatePRHead(null)}
        />
      ) : (
        <div
          aria-labelledby={`github-tab-${tab}`}
          className="min-h-0 flex-1 overflow-hidden"
          id={`github-panel-${tab}`}
          role="tabpanel"
        >
          {tab === "prs" ? (
            <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] divide-x divide-border">
              <div className="min-h-0 overflow-auto">
                <PrList
                  error={prHook.error}
                  hasMore={prHook.hasMore}
                  loading={prHook.loading}
                  loadingMore={prHook.loadingMore}
                  onLoadMore={prHook.loadMore}
                  onSelect={prHook.setSelectedNumber}
                  prs={prHook.prs}
                  selectedNumber={prHook.selectedNumber}
                />
              </div>
              <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
                <PrDetail
                  diff={prHook.diff}
                  diffError={prHook.diffError}
                  diffLoading={prHook.diffLoading}
                  onMerged={() => prHook.refresh()}
                  pr={prHook.selectedPR}
                />
              </div>
            </div>
          ) : tab === "issues" ? (
            <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] divide-x divide-border">
              <div className="min-h-0 overflow-auto">
                <IssueList
                  error={issueHook.error}
                  hasMore={issueHook.hasMore}
                  issues={issueHook.issues}
                  loading={issueHook.loading}
                  loadingMore={issueHook.loadingMore}
                  onLoadMore={issueHook.loadMore}
                  onSelect={issueHook.setSelectedNumber}
                  selectedNumber={issueHook.selectedNumber}
                />
              </div>
              <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
                <IssueDetail
                  commentError={issueHook.commentError}
                  comments={issueHook.comments}
                  commentsLoading={issueHook.commentsLoading}
                  issue={issueHook.selectedIssue}
                  onAddComment={issueHook.addComment}
                  submitting={issueHook.submitting}
                />
              </div>
            </div>
          ) : tab === "branches" ? (
            <BranchesView
              onCountChange={setTabCount}
              onCreatePR={(head) => setCreatePRHead(head)}
              onViewRuns={(head) => {
                setActionsBranch(head);
                setTab("actions");
              }}
            />
          ) : (
            <ActionsView branch={actionsBranch ?? undefined} onCountChange={setTabCount} />
          )}
        </div>
      )}
    </>
  );
}
