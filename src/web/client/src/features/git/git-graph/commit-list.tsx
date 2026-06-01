import { useState, type MutableRefObject } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { GitGraphCommit } from "@/lib/api";
import { AiAskInline } from "../../agent/ai-ask-inline";
import { AiSpark } from "../../agent/ai-spark";
import { useAgentDock } from "../../agent/chat/agent-context";
import { buildCommitPrompt } from "../../agent/prompts";
import { GitGraphSvgRow } from "../git-graph-svg";
import { CiStatusBadge } from "../../github/ci-status-badge";

const ROW_HEIGHT = 28;

export function CommitList({
  commits,
  loading,
  error,
  selectedHash,
  maxLanes,
  rowRefs,
  onSelect,
  onLoadMore,
}: {
  commits: GitGraphCommit[];
  loading: boolean;
  error: string | null;
  selectedHash: string | null;
  maxLanes: number;
  rowRefs: MutableRefObject<Map<string, HTMLLIElement>>;
  onSelect: (hash: string) => void;
  onLoadMore: () => void;
}) {
  const { sendToAgent } = useAgentDock();
  // Which commit row has its inline "what should I do?" field open, if any.
  const [askingHash, setAskingHash] = useState<string | null>(null);

  // Submit the inline intent straight to the agent (no dock round-trip); the
  // chat shows a short label while the agent pulls the diff itself via `git show`.
  function askCommit(commit: GitGraphCommit, input: string) {
    setAskingHash(null);
    sendToAgent({
      prompt: buildCommitPrompt(commit, input),
      source: { type: "git-commit", label: commit.hash.slice(0, 7) },
      label: `${commit.hash.slice(0, 7)}: ${input}`,
    });
  }

  return (
    <aside className="flex min-h-0 flex-col overflow-hidden border-r border-border">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <h2 className="text-[13px] font-semibold tracking-tight">
          Commit tree
          {commits.length ? (
            <span className="ml-2 text-[11px] font-normal text-muted-foreground">
              {commits.length} commits
            </span>
          ) : null}
        </h2>
        <Button
          disabled={loading}
          onClick={onLoadMore}
          size="sm"
          type="button"
          variant="outline"
        >
          Load more
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="p-3">
            <Alert variant="destructive">{error}</Alert>
          </div>
        ) : loading && commits.length === 0 ? (
          <div className="p-3 text-[12px] text-muted-foreground">Loading commits…</div>
        ) : commits.length === 0 ? (
          <div className="p-3 text-[12px] text-muted-foreground">No commits.</div>
        ) : (
          <ul className="divide-y divide-border">
            {commits.map((commit) => (
              <li
                key={commit.hash}
                ref={(el) => {
                  if (el) rowRefs.current.set(commit.hash, el);
                  else rowRefs.current.delete(commit.hash);
                }}
                className="group flex flex-col"
              >
                <div
                  className={`flex items-center transition-colors hover:bg-muted/60 ${
                    selectedHash === commit.hash ? "bg-muted" : ""
                  }`}
                >
                <button
                  onClick={() => onSelect(commit.hash)}
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 px-2 py-0.5 text-left"
                  style={{ minHeight: ROW_HEIGHT }}
                  title={`${commit.hash}\n${commit.author} <${commit.email}>\n${commit.subject}`}
                >
                  <GitGraphSvgRow
                    lane={commit.lane}
                    laneCount={Math.max(commit.laneCount, maxLanes)}
                    edges={commit.edges}
                    throughLanes={commit.throughLanes}
                    isMerge={commit.parents.length > 1}
                    height={ROW_HEIGHT}
                  />
                  <span className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
                    {commit.hash.slice(0, 7)}
                    <CiStatusBadge sha={commit.hash} />
                  </span>
                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    {commit.refs.map((ref) => (
                      <span
                        key={`${ref.kind}-${ref.name}`}
                        className={refBadgeClass(ref.kind)}
                      >
                        {ref.name}
                      </span>
                    ))}
                    <span className="truncate text-[12px]">{commit.subject}</span>
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {commit.author}
                  </span>
                  <span
                    className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70"
                    title={new Date(commit.timestamp * 1000).toLocaleString()}
                  >
                    {formatRelativeTime(commit.timestamp)}
                  </span>
                </button>
                <AiSpark
                  className={`mr-1 shrink-0 ${askingHash === commit.hash ? "opacity-100" : ""}`}
                  label={`Ask AI about commit ${commit.hash.slice(0, 7)}`}
                  onAsk={() =>
                    setAskingHash((current) =>
                      current === commit.hash ? null : commit.hash,
                    )
                  }
                />
                </div>
                {askingHash === commit.hash ? (
                  <div className="px-2 pb-1.5 pt-0.5">
                    <AiAskInline
                      placeholder="What should the agent do with this commit? (explain, summarize, find regressions…)"
                      onSubmit={(value) => askCommit(commit, value)}
                      onCancel={() => setAskingHash(null)}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

/** Compact "time ago" (e.g. 5m, 3h, 2d, 4mo, 1y) from a Unix-seconds timestamp. */
function formatRelativeTime(timestampSeconds: number): string {
  if (!timestampSeconds) return "";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestampSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

function refBadgeClass(kind: GitGraphCommit["refs"][number]["kind"]): string {
  const base = "rounded border px-1.5 py-px text-[10px] font-medium";
  switch (kind) {
    case "head":
      return `${base} border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-emerald-400/30 dark:bg-emerald-500/15 dark:text-emerald-300`;
    case "branch":
      return `${base} border-blue-200 bg-blue-100 text-blue-800 dark:border-blue-400/30 dark:bg-blue-500/15 dark:text-blue-300`;
    case "remote":
      return `${base} border-slate-200 bg-slate-100 text-slate-700 dark:border-zinc-700/80 dark:bg-zinc-800/80 dark:text-zinc-300`;
    case "tag":
      return `${base} border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-400/30 dark:bg-amber-500/15 dark:text-amber-300`;
  }
}
