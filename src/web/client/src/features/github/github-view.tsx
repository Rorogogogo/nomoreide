import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  createGitHubPR,
  getGitHubPRTemplate,
  removeGitHubToken,
  type GitHubPR,
  type GitHubPRTemplate,
} from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useOperations } from "@/components/operations/operation-context";
import { Loading } from "@/components/ui/loading";
import { useRegisterRefresh } from "@/components/refresh-registry";
import { usePersistentState } from "@/lib/use-persistent-state";
import { useT } from "@/lib/i18n";
import { useGitHubToken } from "./hooks/use-github-token";
import { useGitHubPRs } from "./hooks/use-github-prs";
import { useGitHubIssues } from "./hooks/use-github-issues";
import { subscribeToGitHubActions } from "./github-navigation";
import { GitHubLogo } from "./github-logo";
import { GitHubTokenSetup } from "./github-token-setup";
import { PrList } from "./pr-list";
import { PrDetail } from "./pr-detail";
import { IssueList } from "./issue-list";
import { IssueDetail } from "./issue-detail";
import { ActionsView } from "./actions-view";
import { BranchesView } from "./branches-view";

type GithubTab = "prs" | "issues" | "branches" | "actions";

export function GitHubView() {
  const t = useT();
  const token = useGitHubToken();

  let content: React.ReactNode;
  if (token.loading || token.status === "checking") {
    content = <Loading fill label={t("common.loading")} />;
  } else if (token.status === "not_configured") {
    content = (
      <GitHubTokenSetup
        deviceFlowAvailable={token.deviceFlowAvailable}
        onSaved={token.refresh}
      />
    );
  } else if (token.status === "auth_error" || token.status === "connection_error") {
    content = <GitHubConnectionRecovery token={token} />;
  } else {
    content = <GitHubContent token={token} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-card/85">
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
        initialMode={setupMode}
        onSaved={token.refresh}
      />
    );
  }

  const authError = token.status === "auth_error";
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-lg space-y-4 rounded-md border border-border bg-card p-5">
        <div className="flex items-start gap-2">
          <GitHubLogo className="size-5" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">{t("github.connFailed")}</h2>
            <p className="text-[12px] text-muted-foreground">
              {authError ? t("github.tokenRejected") : t("github.cantValidate")}
            </p>
          </div>
          <ConnectionState
            label={authError ? t("github.needsRelogin") : t("github.connProblem")}
            tone={authError ? "danger" : "warning"}
          />
        </div>

        {token.error ? <Alert variant="destructive">{token.error}</Alert> : null}

        <div className="flex flex-wrap gap-2">
          <Button onClick={token.refresh} type="button" variant={authError ? "outline" : "default"}>
            <RefreshCw />
            {t("common.refresh")}
          </Button>
          <Button
            onClick={() => setSetupMode(token.deviceFlowAvailable ? "device-pending" : "pat")}
            type="button"
            variant={authError ? "default" : "outline"}
          >
            {t("github.reconnectGithub")}
          </Button>
          <Button onClick={() => setSetupMode("pat")} type="button" variant="outline">
            {t("github.useToken")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function GitHubContent({ token }: { token: ReturnType<typeof useGitHubToken> }) {
  const t = useT();
  // Sticky so returning to GitHub lands on the tab you left, not back on PRs.
  const [tab, setTab] = usePersistentState<GithubTab>("github:tab", "prs");
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
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const { isPending, runOperation } = useOperations();
  const disconnecting = isPending("github:disconnect");

  const prHook = useGitHubPRs(prState);
  const issueHook = useGitHubIssues(issueState);

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

  const tabButtonClass = (active: boolean) =>
    `rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
      active
        ? "bg-foreground text-background"
        : "text-muted-foreground hover:text-foreground"
    }`;

  const stateButtonClass = (active: boolean) =>
    `rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
      active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
    }`;

  async function handleDisconnect() {
    setDisconnectError(null);
    try {
      await runOperation(
        {
          errorMessage: (error) =>
            error instanceof Error ? error.message : String(error),
          key: "github:disconnect",
          label: t("github.disconnecting"),
        },
        async () => {
          await removeGitHubToken("github.com");
          token.refresh();
        },
      );
    } catch (caught) {
      setDisconnectError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <>
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-card/95 px-3 py-1">
        <button className={tabButtonClass(tab === "prs")} onClick={() => setTab("prs")} type="button">
          {t("github.tab.prs")}
        </button>
        <button className={tabButtonClass(tab === "issues")} onClick={() => setTab("issues")} type="button">
          {t("github.tab.issues")}
        </button>
        <button className={tabButtonClass(tab === "branches")} onClick={() => setTab("branches")} type="button">
          {t("github.tab.branches")}
        </button>
        <button className={tabButtonClass(tab === "actions")} onClick={() => setTab("actions")} type="button">
          {t("github.tab.actions")}
        </button>

        <div className="ml-auto flex min-w-0 items-center gap-2">
          <GitHubConnectionIdentity token={token} />
          <Button onClick={token.refresh} size="sm" title={t("github.recheckTitle")} type="button" variant="outline">
            <RefreshCw />
            {t("github.reconnect")}
          </Button>
          <Button
            loading={disconnecting}
            loadingLabel={t("github.disconnecting")}
            onClick={() => void handleDisconnect()}
            size="sm"
            type="button"
            variant="outline"
          >
            {t("github.disconnect")}
          </Button>
        </div>

        {tab === "prs" ? (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5">
              <button className={stateButtonClass(prState === "open")} onClick={() => setPrState("open")} type="button">{t("github.open")}</button>
              <button className={stateButtonClass(prState === "closed")} onClick={() => setPrState("closed")} type="button">{t("github.closed")}</button>
            </div>
            <Button onClick={() => setCreatePRHead("")} size="sm" type="button" variant="outline">
              {t("github.newPr")}
            </Button>
          </div>
        ) : tab === "issues" ? (
          <div className="flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5">
            <button className={stateButtonClass(issueState === "open")} onClick={() => setIssueState("open")} type="button">{t("github.open")}</button>
            <button className={stateButtonClass(issueState === "closed")} onClick={() => setIssueState("closed")} type="button">{t("github.closed")}</button>
          </div>
        ) : null}
      </div>

      {disconnectError ? (
        <Alert variant="destructive" className="m-3">
          {disconnectError}
        </Alert>
      ) : null}

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
        <div className="min-h-0 flex-1 overflow-hidden">
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
              onCreatePR={(head) => setCreatePRHead(head)}
              onViewRuns={(head) => {
                setActionsBranch(head);
                setTab("actions");
              }}
            />
          ) : (
            <ActionsView
              branch={actionsBranch ?? undefined}
              onClearBranch={() => setActionsBranch(null)}
            />
          )}
        </div>
      )}
    </>
  );
}

function GitHubConnectionIdentity({ token }: { token: ReturnType<typeof useGitHubToken> }) {
  const t = useT();
  const label = token.info?.repository?.full_name ?? (token.info?.user ? `@${token.info.user.login}` : "GitHub");

  return (
    <div className="flex min-w-0 items-center gap-1.5 border-r border-border pr-2">
      <GitHubLogo className="size-4 shrink-0 text-foreground" />
      <ConnectionState label={t("github.connected")} tone="success" />
      <span className="max-w-48 truncate font-mono text-[10px] text-muted-foreground">
        {label}
      </span>
    </div>
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
      <span className={`size-1.5 rounded-full ${toneClass}`} />
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
