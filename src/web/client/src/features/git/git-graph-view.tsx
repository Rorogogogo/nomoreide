import { useMemo, useRef, useState } from "react";
import type { GitBranch } from "@/lib/api";
import { BranchTreeSection, buildBranchTree } from "./git-graph/branch-tree";
import { CommitDiffPanel } from "./git-graph/commit-diff-panel";
import { CommitFilesList } from "./git-graph/commit-files-list";
import { CommitList } from "./git-graph/commit-list";
import { useGitGraph } from "./git-graph/use-git-graph";

export function GitGraphView({ branches = [] }: { branches?: GitBranch[] }) {
  const {
    commits,
    loading,
    error,
    selectedHash,
    setSelectedHash,
    files,
    filesError,
    selectedFile,
    setSelectedFile,
    diff,
    diffLoading,
    diffError,
    maxLanes,
    selectedCommit,
    loadMore,
  } = useGitGraph();
  const [branchQuery, setBranchQuery] = useState("");

  const filteredBranches = useMemo(() => {
    const q = branchQuery.trim().toLowerCase();
    if (!q) return branches;
    return branches.filter((b) => b.name.toLowerCase().includes(q));
  }, [branches, branchQuery]);

  const localTree = useMemo(
    () => buildBranchTree(filteredBranches.filter((b) => !b.remote)),
    [filteredBranches],
  );
  const remoteTree = useMemo(
    () => buildBranchTree(filteredBranches.filter((b) => b.remote)),
    [filteredBranches],
  );
  const searchActive = branchQuery.trim().length > 0;

  const rowRefs = useRef<Map<string, HTMLLIElement>>(new Map());

  function jumpToBranch(branch: GitBranch) {
    // Find the topmost commit whose refs include this branch name+kind.
    const targetKind = branch.remote ? "remote" : "branch";
    const match = commits.find((c) =>
      c.refs.some((r) => r.kind === targetKind && r.name === branch.name),
    );
    if (!match) return;
    setSelectedHash(match.hash);
    const el = rowRefs.current.get(match.hash);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  return (
    <div className="grid h-full min-h-0 overflow-hidden border-0 bg-card/85 grid-cols-[220px_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col overflow-hidden border-r border-border">
        <div className="flex shrink-0 flex-col gap-1 border-b border-border px-3 py-1.5">
          <h2 className="text-[13px] font-semibold tracking-tight">Branches</h2>
          <input
            type="search"
            value={branchQuery}
            onChange={(e) => setBranchQuery(e.target.value)}
            placeholder="Search branches…"
            className="w-full rounded border border-border bg-background px-2 py-1 text-[11px] outline-none focus:border-foreground"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-1">
          <BranchTreeSection
            label="Local"
            tree={localTree}
            onSelect={jumpToBranch}
            defaultOpen
            forceOpen={searchActive}
          />
          <BranchTreeSection
            label="Remote"
            tree={remoteTree}
            onSelect={jumpToBranch}
            forceOpen={searchActive}
          />
        </div>
      </aside>

      <div className="grid min-h-0 min-w-0 grid-rows-[minmax(0,3fr)_minmax(0,2fr)]">
        <CommitDiffPanel
          selectedCommit={selectedCommit}
          selectedFile={selectedFile}
          diff={diff}
          diffLoading={diffLoading}
          diffError={diffError}
        />

        <div className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)_280px]">
          <CommitList
            commits={commits}
            loading={loading}
            error={error}
            selectedHash={selectedHash}
            maxLanes={maxLanes}
            rowRefs={rowRefs}
            onSelect={setSelectedHash}
            onLoadMore={loadMore}
          />
          <CommitFilesList
            files={files}
            filesError={filesError}
            selectedHash={selectedHash}
            selectedFile={selectedFile}
            onSelect={setSelectedFile}
          />
        </div>
      </div>
    </div>
  );
}
