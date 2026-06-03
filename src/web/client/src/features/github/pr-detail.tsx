import { useState } from "react";
import { ExternalLink, GitMerge, Loader2 } from "lucide-react";
import { mergeGitHubPR, type GitHubPR } from "@/lib/api";
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
  const [tab, setTab] = useState<"overview" | "diff">("overview");
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

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
          <button className={tabClass(tab === "overview")} onClick={() => setTab("overview")} type="button">Overview</button>
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

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "overview" ? (
          <div className="space-y-4 p-4">
            <div className="flex flex-wrap gap-2 text-[12px]">
              <MetaChip label="State" value={pr.state} />
              <MetaChip label="Base" value={pr.base.ref} />
              <MetaChip label="Head" value={pr.head.ref} />
              <MetaChip label="Author" value={pr.user.login} />
              <MetaChip label="Created" value={new Date(pr.created_at).toLocaleDateString()} />
            </div>
            {pr.body ? (
              <div className="whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 font-mono text-[12px]">
                {pr.body}
              </div>
            ) : (
              <p className="text-[12px] text-muted-foreground italic">No description provided.</p>
            )}
          </div>
        ) : diffLoading ? (
          <div className="p-4 text-[12px] text-muted-foreground">Loading diff…</div>
        ) : diffError ? (
          <div className="p-4 text-[12px] text-red-500">{diffError}</div>
        ) : diff ? (
          <DiffViewer diff={diff} />
        ) : (
          <div className="p-4 text-[12px] text-muted-foreground">No diff available.</div>
        )}
      </div>
    </div>
  );
}

function MetaChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded border border-border bg-muted/50 px-2 py-0.5 text-[11px]">
      <span className="text-muted-foreground">{label}: </span>
      <span className="font-medium">{value}</span>
    </span>
  );
}
