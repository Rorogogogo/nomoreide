import { useEffect, useState } from "react";
import { ChevronRight, RefreshCw, X } from "lucide-react";
import {
  createGitHubPR,
  getGitHubPRTemplate,
  type GitHubPR,
  type GitHubPRTemplate,
} from "@/lib/api";
import { Alert } from "@/components/ui/alert";
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
import { GitHubLogo } from "./github-logo";
import { GitHubTokenSetup } from "./github-token-setup";
import { GitHubAccountSelector } from "./github-account-selector";
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

function GitHubConnectionRecovery({
  token,
}: {
  token: ReturnType<typeof useGitHubToken>;
}) {
  const t = useT();
  const [setupMode, setSetupMode] = useState<"device-pending" | "pat" | null>(null);

  if (setupMode) {
    return (
      <GitHubTokenSetup
        deviceFlowAvailable={token.deviceFlowAvailable}
        info={token.info}
        initialMode={setupMode}
        onSaved={token.refresh}
      />
    );
  }

  const authError = token.status === "auth_error";
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
      <section aria-labelledby="github-connection-title" className="w-full max-w-lg">
        <div className="flex items-start gap-3">
          <GitHubLogo className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h2 className="text-sm font-semibold" id="github-connection-title">
                {t("github.connFailed")}
              </h2>
              <ConnectionState
                label={authError ? t("github.needsRelogin") : t("github.connProblem")}
                tone={authError ? "danger" : "warning"}
              />
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {authError ? t("github.tokenRejected") : t("github.cantValidate")}
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <Button
                className="h-7 px-2 text-[11px]"
                onClick={() =>
                  setSetupMode(token.deviceFlowAvailable ? "device-pending" : "pat")
                }
                size="sm"
                type="button"
              >
                {t("github.reconnectGithub")}
              </Button>
              {token.info ? (
                <GitHubAccountSelector
                  className="rounded-md border border-border/70 px-0.5"
                  info={token.info}
                  onChanged={token.refresh}
                />
              ) : null}
              <Button
                className="h-7 px-2 text-[11px] [&_svg]:size-3.5"
                onClick={token.refresh}
                size="sm"
                title={t("github.recheckTitle")}
                type="button"
                variant="outline"
              >
                <RefreshCw aria-hidden="true" />
                {t("common.refresh")}
              </Button>
              {token.deviceFlowAvailable ? (
                <Button
                  className="h-7 px-2 text-[11px]"
                  onClick={() => setSetupMode("pat")}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  {t("github.useToken")}
                </Button>
              ) : null}
            </div>
          </div>
        </div>

        {token.error ? (
          <details className="group mt-5 border-y border-border/70">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 px-1 py-2 text-[10px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
              <ChevronRight
                aria-hidden="true"
                className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none"
              />
              {t("github.technicalDetails")}
            </summary>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap border-t border-border/70 bg-muted/15 px-3 py-2 font-mono text-[10px] leading-4 text-muted-foreground">
              {token.error}
            </pre>
          </details>
        ) : null}
      </section>
    </div>
  );
}

/** Tabs and data only — connection identity belongs to the header indicator. */
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

function ConnectionState({
  label,
  tone,
}: {
  label: string;
  tone: "success" | "warning" | "danger";
}) {
  const toneClass =
    tone === "success"
      ? "bg-emerald-500"
      : tone === "danger"
        ? "bg-red-500"
        : "bg-amber-500";

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
      <span aria-hidden="true" className={`size-1.5 rounded-full ${toneClass}`} />
      {label}
    </span>
  );
}

function BranchToPRAssistant({
  initialHead,
  onCreated,
  onCancel,
}: {
  initialHead?: string;
  onCreated: (pr: GitHubPR) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [head, setHead] = useState("");
  const [base, setBase] = useState("main");
  const [draft, setDraft] = useState(false);
  const [template, setTemplate] = useState<GitHubPRTemplate | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void getGitHubPRTemplate()
      .then((next) => {
        if (!active) return;
        setTemplate(next);
        setTitle(next.title);
        setBody(next.body);
        setHead(initialHead || next.head);
        setBase(next.base || next.suggestedBase || "main");
        setDraft(next.draft);
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [initialHead]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !head.trim() || !base.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await createGitHubPR({
        title: title.trim(),
        body: body.trim() || undefined,
        head: head.trim(),
        base: base.trim(),
        draft,
      });
      onCreated(created);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  }

  const fieldClass = "w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring";
  const warnings = template?.warnings ?? [];

  return (
    <form className="flex min-h-0 flex-col gap-3 overflow-auto bg-muted/20 p-4" onSubmit={(e) => void handleSubmit(e)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold">{t("github.branchToPr")}</h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {template?.repository?.full_name ?? t("github.selectedRepo")}
            {template?.currentBranch ? ` - ${template.currentBranch}` : ""}
          </p>
        </div>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {loading ? t("github.detectingBranch") : t("github.editableDraft")}
        </span>
      </div>

      <CompareSummary template={template} loading={loading} />

      {warnings.length > 0 ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-300">
          {warnings[0]}
        </div>
      ) : null}

      <input className={fieldClass} disabled={loading} onChange={(e) => setTitle(e.target.value)} placeholder={t("github.fieldTitle")} required value={title} />
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className="text-[10px] uppercase text-muted-foreground">{t("github.head")}</span>
          <input className={fieldClass} disabled={loading} onChange={(e) => setHead(e.target.value)} placeholder={t("github.headBranch")} required value={head} />
        </label>
        <label className="space-y-1">
          <span className="text-[10px] uppercase text-muted-foreground">{t("github.base")}</span>
          <input className={fieldClass} disabled={loading} onChange={(e) => setBase(e.target.value)} placeholder={t("github.baseBranch")} required value={base} />
        </label>
      </div>
      <textarea
        className={`${fieldClass} resize-none`}
        disabled={loading}
        onChange={(e) => setBody(e.target.value)}
        placeholder={t("github.descriptionOptional")}
        rows={7}
        value={body}
      />
      <label className="flex items-center gap-2 text-[12px]">
        <input checked={draft} className="size-3.5" disabled={loading} onChange={(e) => setDraft(e.target.checked)} type="checkbox" />
        {t("github.createAsDraft")}
      </label>
      {error ? <Alert variant="destructive">{error}</Alert> : null}
      <div className="flex gap-2">
        <Button disabled={loading || submitting || !title.trim() || !head.trim() || !base.trim()} type="submit">{submitting ? t("github.creating") : t("github.createPr")}</Button>
        <Button onClick={onCancel} type="button" variant="outline">{t("common.cancel")}</Button>
      </div>
    </form>
  );
}

function CompareSummary({
  template,
  loading,
}: {
  template: GitHubPRTemplate | null;
  loading: boolean;
}) {
  const t = useT();
  const compare = template?.compare;
  const ci = compare?.ciStatus;
  const items = [
    { label: t("github.compare.base"), value: compare?.base || template?.base || "main" },
    { label: t("github.compare.head"), value: compare?.head || template?.head || "manual" },
    { label: t("github.compare.ahead"), value: loading ? "..." : String(compare?.aheadBy ?? 0) },
    { label: t("github.compare.changed"), value: loading ? "..." : String(compare?.files.length ?? 0) },
    { label: t("github.compare.ci"), value: ci ? `${ci.state} (${ci.totalCount})` : t("github.compare.unavailable") },
  ];

  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-foreground">{t("github.compareSummary")}</span>
        {compare?.headSha ? (
          <span className="font-mono text-[10px] text-muted-foreground">
            {compare.headSha.slice(0, 7)}
          </span>
        ) : null}
      </div>
      <div className="grid grid-cols-5 gap-2">
        {items.map((item) => (
          <div className="min-w-0" key={item.label}>
            <div className="truncate text-[10px] uppercase text-muted-foreground">{item.label}</div>
            <div className="truncate font-mono text-[11px] text-foreground">{item.value}</div>
          </div>
        ))}
      </div>
      {compare?.files.length ? (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {compare.files.slice(0, 4).map((file) => (
            <span className="max-w-52 truncate" key={`${file.status}:${file.path}`}>
              {file.status} {file.path}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
