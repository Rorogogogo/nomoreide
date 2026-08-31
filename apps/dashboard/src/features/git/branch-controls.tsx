import { type FormEvent, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  GitBranch,
  GitPullRequestCreate,
  RefreshCw,
  Upload,
  X,
} from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { gitPush, postForm, type GitBranch as GitBranchInfo } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function BranchControls({
  ahead = 0,
  behind = 0,
  branches,
  currentBranch,
  disabled,
  onRefresh,
  upstream,
}: {
  ahead?: number;
  behind?: number;
  branches: GitBranchInfo[];
  currentBranch?: string;
  disabled?: boolean;
  onRefresh: () => Promise<void>;
  upstream?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const localBranches = branches.filter((branch) => !branch.remote);
  const remoteBranches = branches.filter((branch) => branch.remote);

  async function runAction(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError(null);
    setMessage(null);
    try {
      await action();
      await onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  async function switchBranch(name: string) {
    await runAction(`switch:${name}`, async () => {
      await postForm("/api/git/branches/switch", { name });
      setOpen(false);
    });
  }

  async function fetchBranches() {
    await runAction("fetch", async () => {
      await postForm("/api/git/fetch", {});
      setMessage(t("git.branch.fetched"));
    });
  }

  async function pushBranch() {
    await runAction("push", async () => {
      const result = await gitPush();
      setMessage(
        result.setUpstream
          ? t("git.branch.pushedSetUpstream", { branch: result.branch })
          : t("git.branch.pushed", { branch: result.branch }),
      );
    });
  }

  // Offer push when there are local commits to send, or no upstream yet
  // (a fresh branch). Hidden once the branch is in sync.
  const canPush = !!currentBranch && (ahead > 0 || (!upstream && behind === 0));

  async function createBranch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newBranch.trim();
    if (!name) {
      setError(t("git.branch.nameRequired"));
      return;
    }

    await runAction("create", async () => {
      await postForm("/api/git/branches", { name });
      setNewBranch("");
      setOpen(false);
    });
  }

  return (
    <div className="fixed bottom-12 right-4 z-50 flex items-end">
      {open ? (
        <div
          aria-label={t("git.branch.switchAria")}
          className="mb-11 w-[min(460px,calc(100vw-2rem))] rounded-lg border border-border bg-card shadow-xl"
          role="dialog"
        >
          <div className="flex items-center justify-between gap-3 border-b border-border p-3">
            <div className="flex min-w-0 items-center gap-2">
              <GitBranch className="size-4 text-muted-foreground" />
              <span className="truncate text-sm font-semibold">
                {currentBranch || t("git.branch.branches")}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {canPush ? (
                <Button
                  aria-label={t("git.branch.pushAria")}
                  className="gap-1.5 px-2 text-xs"
                  disabled={disabled || busy !== null}
                  onClick={() => void pushBranch()}
                  size="sm"
                  title={
                    upstream
                      ? t("git.branch.pushCountTo", { ahead, upstream })
                      : t("git.branch.pushSetUpstream")
                  }
                  type="button"
                  variant="default"
                >
                  <Upload className={cn("size-3.5", busy === "push" && "animate-pulse")} />
                  {t("git.branch.push")}{ahead > 0 ? ` ${ahead}` : ""}
                </Button>
              ) : null}
              <Button
                aria-label={t("git.branch.fetchAria")}
                disabled={disabled || busy !== null}
                onClick={() => void fetchBranches()}
                size="icon"
                title={t("git.branch.fetchAria")}
                type="button"
                variant="ghost"
              >
                <RefreshCw className={cn(busy === "fetch" && "animate-spin")} />
              </Button>
              <Button
                aria-label={t("git.branch.closeAria")}
                onClick={() => setOpen(false)}
                size="icon"
                type="button"
                variant="ghost"
              >
                <X />
              </Button>
            </div>
          </div>

          <div className="max-h-72 overflow-auto">
            {branches.length ? (
              <>
                <BranchSection
                  branches={localBranches}
                  busy={busy !== null}
                  disabled={disabled}
                  empty={t("git.branch.noLocal")}
                  label={t("git.branch.sectionLocal")}
                  onSwitch={switchBranch}
                />
                <BranchSection
                  branches={remoteBranches}
                  busy={busy !== null}
                  disabled={disabled}
                  empty={t("git.branch.noRemote")}
                  label={t("git.branch.sectionRemote")}
                  onSwitch={switchBranch}
                />
              </>
            ) : (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                {t("git.branch.noneFound")}
              </div>
            )}
          </div>

          <div className="border-t border-border p-3">
            <form className="grid gap-2 sm:grid-cols-[1fr_auto]" onSubmit={createBranch}>
              <Input
                aria-label={t("git.branch.newNameAria")}
                disabled={disabled || busy !== null}
                onChange={(event) => {
                  setNewBranch(event.target.value);
                  setError(null);
                  setMessage(null);
                }}
                placeholder="feature/new-work"
                value={newBranch}
              />
              <Button disabled={disabled || busy !== null} type="submit">
                <GitPullRequestCreate />
                {t("git.branch.create")}
              </Button>
            </form>

            {error || message ? (
              <Alert className="mt-3 px-3 py-2 text-xs" variant={error ? "destructive" : "muted"}>
                {error ?? message}
              </Alert>
            ) : null}
          </div>
        </div>
      ) : null}

      <Button
        className="h-8 max-w-[260px] gap-2 rounded-md shadow-lg"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        size="sm"
        title={t("git.branch.switchAria")}
        type="button"
        variant="default"
      >
        <GitBranch className="size-4" />
        <span className="truncate font-mono text-xs">{currentBranch || t("git.branch.noBranch")}</span>
        {currentBranch && (ahead > 0 || behind > 0) ? (
          <span
            className="flex items-center gap-1 font-mono text-[11px] tabular-nums"
            title={
              upstream
                ? t("git.branch.aheadBehindUpstream", { ahead, behind, upstream })
                : t("git.branch.aheadBehind", { ahead, behind })
            }
          >
            {behind > 0 ? (
              <span className="flex items-center">
                <ArrowDown className="size-3" />
                {behind}
              </span>
            ) : null}
            {ahead > 0 ? (
              <span className="flex items-center">
                <ArrowUp className="size-3" />
                {ahead}
              </span>
            ) : null}
          </span>
        ) : null}
        <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
      </Button>
    </div>
  );
}

function BranchSection({
  branches,
  busy,
  disabled,
  empty,
  label,
  onSwitch,
}: {
  branches: GitBranchInfo[];
  busy: boolean;
  disabled?: boolean;
  empty: string;
  label: string;
  onSwitch: (name: string) => Promise<void>;
}) {
  const t = useT();
  return (
    <section>
      <div className="border-b border-border bg-muted/60 px-3 py-1.5 text-[11px] font-semibold uppercase text-muted-foreground">
        {label}
      </div>
      {branches.length ? (
        branches.map((branch) => (
          <button
            className={cn(
              "grid w-full grid-cols-[1fr_auto] items-center gap-2 border-b border-border px-3 py-2 text-left text-sm last:border-b-0 hover:bg-muted",
              branch.current && "bg-muted/70",
            )}
            disabled={disabled || busy || branch.current}
            key={`${branch.remote ? "remote" : "local"}:${branch.name}`}
            onClick={() => void onSwitch(branch.name)}
            type="button"
          >
            <span className="min-w-0">
              <span className="block truncate font-medium">{branch.name}</span>
              {branch.upstream ? (
                <span className="block truncate font-mono text-[11px] text-muted-foreground">
                  {t("git.branch.tracks", { upstream: branch.upstream })}
                </span>
              ) : null}
            </span>
            <Badge variant={branch.current ? "success" : branch.remote ? "outline" : "secondary"}>
              {branch.current
                ? t("git.branch.tagCurrent")
                : branch.remote
                  ? t("git.branch.tagRemote")
                  : t("git.branch.tagLocal")}
            </Badge>
          </button>
        ))
      ) : (
        <div className="border-b border-border px-3 py-3 text-sm text-muted-foreground">
          {empty}
        </div>
      )}
    </section>
  );
}
