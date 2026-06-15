import { useEffect, useMemo, useState } from "react";
import { GitBranch, GitPullRequest, PlayCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { listGitHubBranches, type GitHubBranchInfo, type GitHubBranchesPayload } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useRegisterRefresh } from "@/components/refresh-registry";

export function BranchesView({
  onCreatePR,
  onViewRuns,
}: {
  onCreatePR: (head: string) => void;
  onViewRuns: (head: string) => void;
}) {
  const [payload, setPayload] = useState<GitHubBranchesPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    let active = true;
    setLoading(true);
    setError(null);
    void listGitHubBranches()
      .then((next) => {
        if (active) setPayload(next);
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }

  useEffect(refresh, []);
  useRegisterRefresh(() => {
    refresh();
  });

  const branches = useMemo(() => {
    const items = payload?.branches ?? [];
    return [...items].sort((left, right) => {
      const leftRank = branchRank(left, payload);
      const rightRank = branchRank(right, payload);
      return leftRank - rightRank || left.name.localeCompare(right.name);
    });
  }, [payload]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold">Branches</h2>
          <p className="truncate text-[11px] text-muted-foreground">
            {payload?.repository.full_name ?? "Selected repository"}
          </p>
        </div>
        <Button
          disabled={loading}
          onClick={() => void refresh()}
          size="sm"
          type="button"
          variant="outline"
        >
          <RefreshCw className={`mr-1 size-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="p-4 text-[12px] text-red-500">{error}</div>
        ) : loading && !payload ? (
          <div className="p-4 text-[12px] text-muted-foreground">Loading branches...</div>
        ) : branches.length === 0 ? (
          <div className="p-4 text-[12px] text-muted-foreground">No branches found.</div>
        ) : (
          <ul className="divide-y divide-border">
            {branches.map((branch) => (
              <BranchRow
                branch={branch}
                currentBranch={payload?.currentBranch ?? null}
                defaultBranch={payload?.defaultBranch ?? null}
                key={branch.name}
                onCreatePR={onCreatePR}
                onViewRuns={onViewRuns}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function BranchRow({
  branch,
  defaultBranch,
  currentBranch,
  onCreatePR,
  onViewRuns,
}: {
  branch: GitHubBranchInfo;
  defaultBranch: string | null;
  currentBranch: string | null;
  onCreatePR: (head: string) => void;
  onViewRuns: (head: string) => void;
}) {
  const isDefault = branch.name === defaultBranch;
  const isCurrent = branch.name === currentBranch;
  const canOpenPR = !isDefault;

  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-2.5">
      <GitBranch className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-48 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-[13px] font-medium">{branch.name}</span>
          {isDefault ? <StatusText label="Default" tone="success" /> : null}
          {isCurrent ? <StatusText label="Current" tone="warning" /> : null}
          {branch.protected ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
              <ShieldCheck className="size-3" />
              protected
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
          {branch.commit.sha.slice(0, 7)}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          onClick={() => onViewRuns(branch.name)}
          size="sm"
          title={`View workflow runs for ${branch.name}`}
          type="button"
          variant="outline"
        >
          <PlayCircle className="size-3.5" />
          View runs
        </Button>
        <Button
          disabled={!canOpenPR}
          onClick={() => onCreatePR(branch.name)}
          size="sm"
          title={canOpenPR ? `Open PR from ${branch.name}` : "Default branch does not need a PR"}
          type="button"
          variant="outline"
        >
          <GitPullRequest className="size-3.5" />
          Open PR
        </Button>
      </div>
    </li>
  );
}

function StatusText({
  label,
  tone,
}: {
  label: string;
  tone: "success" | "warning";
}) {
  const dot = tone === "success" ? "bg-emerald-500" : "bg-amber-500";
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
      <span className={`size-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

function branchRank(branch: GitHubBranchInfo, payload: GitHubBranchesPayload | null): number {
  if (branch.name === payload?.currentBranch) return 0;
  if (branch.name === payload?.defaultBranch) return 1;
  if (branch.protected) return 2;
  return 3;
}
