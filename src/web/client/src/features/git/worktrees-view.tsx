import { useCallback, useEffect, useState } from "react";
import {
  Bot,
  GitBranch,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  TreePine,
} from "lucide-react";
import { Badge } from "@/components/ui/cvui-badge";
import { Button } from "@/components/ui/button";
import { useToasts } from "@/components/ui/toast";
import { useAgentDock } from "../agent/chat/agent-context";
import {
  createGitWorktree,
  getGitWorktrees,
  gitBranches,
  pruneGitWorktrees,
  removeGitWorktree,
  selectGitWorktree,
  type GitBranch as GitBranchInfo,
  type GitWorktree,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function WorktreesView({
  onRefresh,
}: {
  onRefresh?: () => void | Promise<void>;
}) {
  const t = useT();
  const { createTask, setOpen: setAgentDockOpen } = useAgentDock();
  const { error: showError, success: showSuccess } = useToasts();
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [activePath, setActivePath] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [branch, setBranch] = useState("");
  const [baseRef, setBaseRef] = useState("HEAD");
  const [baseBranches, setBaseBranches] = useState<GitBranchInfo[]>([]);
  const [createBranch, setCreateBranch] = useState(true);
  const [launchAgent, setLaunchAgent] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await getGitWorktrees();
      setWorktrees(result.worktrees);
      setActivePath(result.activePath);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!creating || !createBranch) return;
    let cancelled = false;
    void gitBranches()
      .then((branches) => {
        if (!cancelled) setBaseBranches(branches);
      })
      .catch(() => {
        // Branch suggestions are optional; custom Git refs remain available.
      });
    return () => {
      cancelled = true;
    };
  }, [createBranch, creating]);

  async function activate(worktree: GitWorktree) {
    if (worktree.path === activePath) return;
    setBusy(`activate:${worktree.path}`);
    try {
      await selectGitWorktree(worktree.path);
      setActivePath(worktree.path);
      await onRefresh?.();
      showSuccess(t("git.worktrees.activated", { branch: worktree.branch ?? "HEAD" }));
    } catch (caught) {
      showError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function create() {
    if (!branch.trim()) return;
    setBusy("create");
    try {
      const worktree = await createGitWorktree({
        branch: branch.trim(),
        createBranch,
        baseRef: createBranch ? baseRef.trim() || "HEAD" : undefined,
      });
      setBranch("");
      setCreating(false);
      await Promise.all([load(), onRefresh?.()]);
      showSuccess(t("git.worktrees.created", { branch: worktree.branch ?? branch }));
      if (launchAgent) {
        await createTask({
          prompt: t("git.worktrees.agentPrompt", {
            branch: worktree.branch ?? "HEAD",
            path: worktree.path,
          }),
          label: t("git.worktrees.agentLabel", {
            branch: worktree.branch ?? "HEAD",
          }),
        });
        setAgentDockOpen(true);
      }
    } catch (caught) {
      showError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function remove(worktree: GitWorktree) {
    const label = worktree.branch ?? worktree.path;
    if (!window.confirm(t("git.worktrees.removeConfirm", { branch: label }))) return;
    setBusy(`remove:${worktree.path}`);
    try {
      await removeGitWorktree(worktree.path);
      await load();
      showSuccess(t("git.worktrees.removed", { branch: label }));
    } catch (caught) {
      showError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function prune() {
    setBusy("prune");
    try {
      await pruneGitWorktrees();
      await load();
      showSuccess(t("git.worktrees.pruned"));
    } catch (caught) {
      showError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card/75 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <TreePine aria-hidden="true" className="size-4 text-muted-foreground" />
          <span className="text-xs font-semibold">{t("git.worktrees.title")}</span>
          <span className="font-mono text-[9px] tabular-nums text-muted-foreground">
            {worktrees.length}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button
            disabled={busy !== null}
            onClick={() => setCreating((value) => !value)}
            size="sm"
            type="button"
            variant={creating ? "secondary" : "default"}
          >
            <Plus aria-hidden="true" />
            {t("git.worktrees.new")}
          </Button>
          <Button
            aria-label={t("git.worktrees.prune")}
            className="size-7"
            disabled={busy !== null}
            onClick={() => void prune()}
            size="icon"
            title={t("git.worktrees.prune")}
            type="button"
            variant="ghost"
          >
            <RefreshCw
              aria-hidden="true"
              className={cn("size-3.5", busy === "prune" && "animate-spin")}
            />
          </Button>
        </div>
      </div>

      {creating ? (
        <form
          className="grid shrink-0 items-start gap-2 border-b border-border bg-muted/15 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.7fr)_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label className="grid content-start gap-1 text-[10px] text-muted-foreground">
            {t("git.worktrees.branch")}
            <input
              className="h-8 rounded-md border border-input bg-background px-2 font-mono text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
              onChange={(event) => setBranch(event.target.value)}
              placeholder="feature/my-task"
              value={branch}
            />
          </label>
          <label className="grid content-start gap-1 text-[10px] text-muted-foreground">
            {t("git.worktrees.base")}
            <input
              aria-describedby="worktree-start-from-hint"
              className="h-8 rounded-md border border-input bg-background px-2 font-mono text-xs text-foreground outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
              disabled={!createBranch}
              list="worktree-start-points"
              onChange={(event) => setBaseRef(event.target.value)}
              placeholder={t("git.worktrees.basePlaceholder")}
              value={baseRef}
            />
            <datalist id="worktree-start-points">
              <option label={t("git.worktrees.refHead")} value="HEAD" />
              {baseBranches.map((candidate) => (
                <option
                  key={`${candidate.remote ? "remote" : "local"}:${candidate.name}`}
                  label={t(
                    candidate.remote
                      ? "git.worktrees.refRemote"
                      : "git.worktrees.refLocal",
                  )}
                  value={candidate.name}
                />
              ))}
            </datalist>
            <span className="font-normal text-[9px]" id="worktree-start-from-hint">
              {t("git.worktrees.baseHint")}
            </span>
          </label>
          <div className="flex items-start sm:pt-[18px]">
            <Button
              className="h-8 w-full sm:w-auto"
              disabled={!branch.trim() || busy !== null}
              type="submit"
            >
              {busy === "create" ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : (
                <Plus aria-hidden="true" />
              )}
              {t("git.worktrees.create")}
            </Button>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-2 sm:col-span-3">
            <CheckOption
              checked={createBranch}
              label={t("git.worktrees.createBranch")}
              onChange={setCreateBranch}
            />
            <CheckOption
              checked={launchAgent}
              icon={<Bot aria-hidden="true" className="size-3" />}
              label={t("git.worktrees.launchAgent")}
              onChange={setLaunchAgent}
            />
          </div>
        </form>
      ) : null}

      {error ? (
        <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            {t("git.worktrees.loading")}
          </div>
        ) : worktrees.length === 0 ? (
          <div className="px-4 py-10 text-center text-xs text-muted-foreground">
            {t("git.worktrees.empty")}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {worktrees.map((worktree) => {
              const active = worktree.path === activePath;
              const rowBusy =
                busy === `activate:${worktree.path}` ||
                busy === `remove:${worktree.path}`;
              const canRemove =
                !active &&
                !worktree.primary &&
                !worktree.dirty &&
                !worktree.locked &&
                !worktree.prunable;
              return (
                <div
                  className={cn(
                    "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-3 transition-colors",
                    active ? "bg-muted/45" : "hover:bg-muted/20",
                  )}
                  key={worktree.path}
                >
                  <button
                    className="min-w-0 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    disabled={active || rowBusy}
                    onClick={() => void activate(worktree)}
                    type="button"
                  >
                    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <GitBranch aria-hidden="true" className="size-3.5 text-muted-foreground" />
                      <span className="truncate text-sm font-semibold">
                        {worktree.branch ?? t("git.worktrees.detached")}
                      </span>
                      {active ? <Badge size="small">{t("git.worktrees.active")}</Badge> : null}
                      {worktree.primary ? (
                        <Badge appearance="outline" size="small">
                          {t("git.worktrees.primary")}
                        </Badge>
                      ) : null}
                      {worktree.dirty ? (
                        <Badge appearance="subtle" size="small" variant="warning">
                          {t("git.worktrees.dirty")}
                        </Badge>
                      ) : null}
                      {worktree.locked ? (
                        <Badge appearance="subtle" size="small" variant="warning">
                          {t("git.worktrees.locked")}
                        </Badge>
                      ) : null}
                      {worktree.prunable ? (
                        <Badge appearance="subtle" size="small" variant="error">
                          {t("git.worktrees.stale")}
                        </Badge>
                      ) : null}
                    </span>
                    <span
                      className="mt-1 block truncate font-mono text-[10px] text-muted-foreground"
                      title={worktree.path}
                    >
                      {worktree.path}
                    </span>
                    <span className="mt-1 block font-mono text-[9px] text-muted-foreground">
                      {worktree.head.slice(0, 12)}
                      {worktree.lockedReason ? ` · ${worktree.lockedReason}` : ""}
                      {worktree.prunableReason ? ` · ${worktree.prunableReason}` : ""}
                    </span>
                  </button>
                  <div className="flex items-center gap-1">
                    {!active ? (
                      <Button
                        disabled={busy !== null}
                        onClick={() => void activate(worktree)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        {t("git.worktrees.activate")}
                      </Button>
                    ) : null}
                    {!worktree.primary ? (
                      <Button
                        aria-label={t("git.worktrees.remove", {
                          branch: worktree.branch ?? worktree.path,
                        })}
                        className="size-7"
                        disabled={!canRemove || busy !== null}
                        onClick={() => void remove(worktree)}
                        size="icon"
                        title={
                          canRemove
                            ? t("git.worktrees.remove", {
                                branch: worktree.branch ?? worktree.path,
                              })
                            : t("git.worktrees.removeBlocked")
                        }
                        type="button"
                        variant="ghost"
                      >
                        {rowBusy ? (
                          <Loader2 aria-hidden="true" className="animate-spin" />
                        ) : (
                          <Trash2 aria-hidden="true" className="text-destructive" />
                        )}
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function CheckOption({
  checked,
  icon,
  label,
  onChange,
}: {
  checked: boolean;
  icon?: React.ReactNode;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-[10px] text-muted-foreground">
      <input
        checked={checked}
        className="size-3 accent-foreground"
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      {icon}
      {label}
    </label>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
