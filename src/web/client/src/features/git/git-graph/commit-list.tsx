import type { MutableRefObject } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { GitGraphCommit } from "@/lib/api";
import { GitGraphSvgRow } from "../git-graph-svg";

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
              >
                <button
                  onClick={() => onSelect(commit.hash)}
                  type="button"
                  className={`flex w-full items-center gap-2 px-2 py-0.5 text-left transition-colors hover:bg-muted/60 ${
                    selectedHash === commit.hash ? "bg-muted" : ""
                  }`}
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
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {commit.hash.slice(0, 7)}
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
  const base = "rounded px-1.5 py-px text-[10px] font-medium";
  switch (kind) {
    case "head":
      return `${base} bg-emerald-100 text-emerald-800`;
    case "branch":
      return `${base} bg-blue-100 text-blue-800`;
    case "remote":
      return `${base} bg-slate-100 text-slate-700`;
    case "tag":
      return `${base} bg-amber-100 text-amber-800`;
  }
}
