import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, GitBranch as BranchIcon } from "lucide-react";
import {
  getGitCommitDiff,
  getGitCommitFiles,
  getGitGraph,
  type GitBranch,
  type GitFileStatus,
  type GitGraphCommit,
} from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DiffViewer } from "./diff-viewer";
import { GitGraphSvgRow } from "./git-graph-svg";

const DEFAULT_LIMIT = 200;
const ROW_HEIGHT = 28;

interface BranchNode {
  name: string;
  fullPath: string;
  branch?: GitBranch;
  children: Map<string, BranchNode>;
}

export function GitGraphView({ branches = [] }: { branches?: GitBranch[] }) {
  const [commits, setCommits] = useState<GitGraphCommit[]>([]);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [files, setFiles] = useState<GitFileStatus[]>([]);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diff, setDiff] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [branchQuery, setBranchQuery] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void getGitGraph(limit)
      .then((next) => {
        if (!active) return;
        setCommits(next);
        if (next.length > 0 && !next.some((c) => c.hash === selectedHash)) {
          setSelectedHash(next[0].hash);
        }
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // selectedHash intentionally not in deps — we only want to seed it on first/refresh load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limit]);

  useEffect(() => {
    if (!selectedHash) {
      setFiles([]);
      setSelectedFile(null);
      return;
    }
    let active = true;
    setFilesError(null);
    void getGitCommitFiles(selectedHash)
      .then((next) => {
        if (!active) return;
        setFiles(next);
        setSelectedFile(next[0]?.path ?? null);
      })
      .catch((caught) => {
        if (active) setFilesError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      active = false;
    };
  }, [selectedHash]);

  useEffect(() => {
    if (!selectedHash) {
      setDiff("");
      return;
    }
    let active = true;
    setDiffError(null);
    setDiffLoading(true);
    void getGitCommitDiff(selectedHash, selectedFile ?? undefined)
      .then((next) => {
        if (active) setDiff(next);
      })
      .catch((caught) => {
        if (active) setDiffError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (active) setDiffLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedHash, selectedFile]);

  const maxLanes = useMemo(
    () => commits.reduce((acc, c) => Math.max(acc, c.laneCount), 1),
    [commits],
  );

  const selectedCommit = commits.find((c) => c.hash === selectedHash) ?? null;

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
      <section className="flex min-h-0 min-w-0 flex-col bg-white border-b border-border">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-1.5">
          <div className="min-w-0">
            <h2 className="truncate text-[13px] font-semibold tracking-tight">
              {selectedFile ?? (selectedCommit ? selectedCommit.subject : "Commit")}
            </h2>
            {selectedCommit ? (
              <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                <span className="font-mono">{selectedCommit.hash.slice(0, 12)}</span>
                <span>
                  {selectedCommit.author} &lt;{selectedCommit.email}&gt;
                </span>
                <span>
                  {new Date(selectedCommit.timestamp * 1000).toLocaleString()}
                </span>
              </div>
            ) : null}
          </div>
        </div>
        <div className="min-h-0 min-w-0 flex-1">
          {diffError ? (
            <div className="p-4">
              <Alert variant="destructive">{diffError}</Alert>
            </div>
          ) : selectedCommit ? (
            diffLoading ? (
              <div className="p-4 text-[12px] text-muted-foreground">Loading diff…</div>
            ) : diff ? (
              <DiffViewer activeHunkIndex={0} diff={diff} />
            ) : (
              <div className="p-4">
                <Alert variant="muted" className="border-dashed p-6 text-center">
                  {selectedCommit.parents.length > 1
                    ? "Merge commit with no conflict resolution — no diff against the first parent."
                    : "No textual changes in this commit."}
                </Alert>
              </div>
            )
          ) : (
            <div className="p-4">
              <Alert variant="muted" className="border-dashed p-12 text-center">
                Select a commit to inspect its diff.
              </Alert>
            </div>
          )}
        </div>
      </section>

      <div className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)_280px]">
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
            onClick={() => setLimit((n) => n + DEFAULT_LIMIT)}
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
                    onClick={() => setSelectedHash(commit.hash)}
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
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      <aside className="flex min-h-0 flex-col overflow-hidden border-r border-border">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5">
          <h2 className="text-[13px] font-semibold tracking-tight">
            Files
            {files.length ? (
              <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                {files.length}
              </span>
            ) : null}
          </h2>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {filesError ? (
            <div className="p-3">
              <Alert variant="destructive">{filesError}</Alert>
            </div>
          ) : !selectedHash ? (
            <div className="p-3 text-[12px] text-muted-foreground">
              Select a commit to see its files.
            </div>
          ) : files.length === 0 ? (
            <div className="p-3 text-[12px] text-muted-foreground">No file changes.</div>
          ) : (
            <ul className="divide-y divide-border">
              {files.map((file) => (
                <li key={file.path}>
                  <button
                    onClick={() => setSelectedFile(file.path)}
                    type="button"
                    title={file.path}
                    className={`flex w-full items-center gap-2 px-2 py-1 text-left text-[12px] transition-colors hover:bg-muted/60 ${
                      selectedFile === file.path ? "bg-muted" : ""
                    }`}
                  >
                    <span className={fileStatusClass(file.index)}>{file.index.trim() || "·"}</span>
                    <span className="truncate font-mono">{file.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
      </div>
      </div>
    </div>
  );
}

function buildBranchTree(branches: GitBranch[]): BranchNode {
  const root: BranchNode = { name: "", fullPath: "", children: new Map() };
  for (const branch of branches) {
    const segments = branch.name.split("/");
    let node = root;
    segments.forEach((segment, idx) => {
      let child = node.children.get(segment);
      if (!child) {
        child = {
          name: segment,
          fullPath: segments.slice(0, idx + 1).join("/"),
          children: new Map(),
        };
        node.children.set(segment, child);
      }
      node = child;
    });
    node.branch = branch;
  }
  return root;
}

function BranchTreeSection({
  label,
  tree,
  onSelect,
  defaultOpen,
  forceOpen,
}: {
  label: string;
  tree: BranchNode;
  onSelect: (branch: GitBranch) => void;
  defaultOpen?: boolean;
  forceOpen?: boolean;
}) {
  const [openState, setOpen] = useState(defaultOpen ?? false);
  const open = forceOpen || openState;
  const isEmpty = tree.children.size === 0;
  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1 px-2 py-0.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {label}
        {isEmpty ? null : (
          <span className="ml-1 text-[10px] font-normal">({tree.children.size})</span>
        )}
      </button>
      {open && !isEmpty ? (
        <ul>
          {Array.from(tree.children.values()).map((child) => (
            <BranchTreeNode
              key={child.fullPath}
              node={child}
              depth={1}
              onSelect={onSelect}
              forceOpen={forceOpen}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function BranchTreeNode({
  node,
  depth,
  onSelect,
  forceOpen,
}: {
  node: BranchNode;
  depth: number;
  onSelect: (branch: GitBranch) => void;
  forceOpen?: boolean;
}) {
  const [openState, setOpen] = useState(true);
  const open = forceOpen || openState;
  const hasChildren = node.children.size > 0;
  const branch = node.branch;
  const indent = { paddingLeft: `${depth * 10}px` };

  if (!hasChildren && branch) {
    return (
      <li>
        <button
          type="button"
          onClick={() => onSelect(branch)}
          style={indent}
          title={branch.name}
          className={`flex w-full items-center gap-1.5 py-0.5 pr-2 text-left text-[12px] hover:bg-muted/60 ${
            branch.current ? "font-semibold text-emerald-700" : ""
          }`}
        >
          <BranchIcon size={11} className="shrink-0 opacity-70" />
          <span className="truncate">{node.name}</span>
          {branch.current ? <span className="text-[10px]">●</span> : null}
        </button>
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        onClick={() => {
          if (branch) onSelect(branch);
          else setOpen((o) => !o);
        }}
        style={indent}
        className="flex w-full items-center gap-1 py-0.5 pr-2 text-left text-[12px] hover:bg-muted/60"
      >
        {hasChildren ? (
          open ? <ChevronDown size={11} /> : <ChevronRight size={11} />
        ) : (
          <span className="inline-block w-[11px]" />
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {open && hasChildren ? (
        <ul>
          {Array.from(node.children.values()).map((child) => (
            <BranchTreeNode
              key={child.fullPath}
              node={child}
              depth={depth + 1}
              onSelect={onSelect}
              forceOpen={forceOpen}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function fileStatusClass(status: string): string {
  const base = "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-bold";
  const letter = status.trim().toUpperCase();
  switch (letter) {
    case "A":
      return `${base} bg-emerald-100 text-emerald-800`;
    case "D":
      return `${base} bg-red-100 text-red-800`;
    case "M":
      return `${base} bg-amber-100 text-amber-800`;
    case "R":
      return `${base} bg-blue-100 text-blue-800`;
    case "C":
      return `${base} bg-indigo-100 text-indigo-800`;
    default:
      return `${base} bg-slate-100 text-slate-700`;
  }
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
