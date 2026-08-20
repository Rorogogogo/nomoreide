import { useState } from "react";
import { ChevronDown, ChevronRight, GitBranch as BranchIcon } from "lucide-react";
import type { GitBranch } from "@/lib/api";

export interface BranchNode {
  name: string;
  fullPath: string;
  branch?: GitBranch;
  children: Map<string, BranchNode>;
}

/** Build a nested tree from slash-delimited branch names (e.g. `feat/x/y`). */
export function buildBranchTree(branches: GitBranch[]): BranchNode {
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

export function BranchTreeSection({
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
