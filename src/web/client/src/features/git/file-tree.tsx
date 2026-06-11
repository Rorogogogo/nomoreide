import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  ListCollapse,
  ListTree,
} from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import type { GitFileStatus } from "@/lib/api";
import { cn } from "@/lib/utils";
import { absolutePath, agentPathDragProps } from "../agent/chat/drag-to-agent";
import { BranchNameBadge } from "./branch-name-badge";
import { FileKindIcon } from "./file-kind-icon";

interface TreeNode {
  name: string;
  path: string;
  children: TreeNode[];
  isFile: boolean;
}

function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: [], isFile: false };
  const dirMap = new Map<string, TreeNode>();
  dirMap.set("", root);

  const sorted = [...paths].sort();
  for (const path of sorted) {
    const parts = path.split("/");
    let parentPath = "";
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      const isFile = i === parts.length - 1;
      const currentPath = parentPath ? `${parentPath}/${part}` : part;
      let node = dirMap.get(currentPath);
      if (!node) {
        node = { name: part, path: currentPath, children: [], isFile };
        dirMap.set(currentPath, node);
        dirMap.get(parentPath)?.children.push(node);
      }
      parentPath = currentPath;
    }
  }

  // Sort: directories before files, then alpha.
  const sortRecursive = (node: TreeNode) => {
    node.children.sort((a, b) => {
      if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortRecursive);
  };
  sortRecursive(root);
  return root;
}

function expandedDirectoryMap(tree: TreeNode, expandAll: boolean): Record<string, boolean> {
  const out: Record<string, boolean> = { "": true };
  const visit = (node: TreeNode) => {
    for (const child of node.children) {
      if (!child.isFile) {
        out[child.path] = true;
        if (expandAll) visit(child);
      }
    }
  };
  visit(tree);
  return out;
}

export function FileTree({
  defaultExpandAll = false,
  paths,
  status,
  selectedFile,
  onSelectFile,
  branch,
  emptyMessage = "No tracked files.",
  root,
  title = "Files",
}: {
  defaultExpandAll?: boolean;
  paths: string[];
  status: GitFileStatus[];
  selectedFile: string;
  onSelectFile: (path: string) => void;
  branch?: string;
  emptyMessage?: string;
  /** Absolute repo root; lets rows be dragged into the agent dock by path. */
  root?: string;
  title?: string;
}) {
  const tree = useMemo(() => buildTree(paths), [paths]);
  const initialExpanded = useMemo(
    () => expandedDirectoryMap(tree, defaultExpandAll),
    [defaultExpandAll, tree],
  );
  const allExpanded = useMemo(() => expandedDirectoryMap(tree, true), [tree]);
  const directoryCount = Math.max(0, Object.keys(allExpanded).length - 1);
  const statusByPath = useMemo(() => {
    const map = new Map<string, GitFileStatus>();
    for (const file of status) map.set(file.path, file);
    return map;
  }, [status]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(initialExpanded);
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (seeded || tree.children.length === 0) return;
    setExpanded(initialExpanded);
    setSeeded(true);
  }, [initialExpanded, seeded, tree.children.length]);

  function toggle(path: string) {
    setExpanded((current) => ({ ...current, [path]: !current[path] }));
  }

  function expandAllFolders() {
    setExpanded(allExpanded);
  }

  function collapseAllFolders() {
    setExpanded({ "": true });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-card/95 px-2.5 py-1.5">
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] font-semibold tracking-tight">
          <Folder className="size-3.5" />
          <span className="truncate">{title}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {directoryCount > 0 ? (
            <span className="flex items-center gap-0.5">
              <button
                aria-label="Expand all folders"
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                onClick={expandAllFolders}
                title="Expand all folders"
                type="button"
              >
                <ListTree className="size-3.5" />
              </button>
              <button
                aria-label="Collapse all folders"
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                onClick={collapseAllFolders}
                title="Collapse all folders"
                type="button"
              >
                <ListCollapse className="size-3.5" />
              </button>
            </span>
          ) : null}
          {branch ? <BranchNameBadge branch={branch} /> : null}
          <Badge variant="secondary">{paths.length}</Badge>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {tree.children.length === 0 ? (
          <Alert variant="muted" className="m-3 text-center">
            {emptyMessage}
          </Alert>
        ) : (
          tree.children.map((node) => (
            <TreeRow
              depth={0}
              expanded={expanded}
              key={node.path}
              node={node}
              onSelectFile={onSelectFile}
              onToggle={toggle}
              root={root}
              selectedFile={selectedFile}
              statusByPath={statusByPath}
            />
          ))
        )}
      </div>
    </div>
  );
}

function TreeRow({
  depth,
  expanded,
  node,
  onSelectFile,
  onToggle,
  root,
  selectedFile,
  statusByPath,
}: {
  depth: number;
  expanded: Record<string, boolean>;
  node: TreeNode;
  onSelectFile: (path: string) => void;
  onToggle: (path: string) => void;
  root?: string;
  selectedFile: string;
  statusByPath: Map<string, GitFileStatus>;
}) {
  const isOpen = expanded[node.path] ?? false;
  const paddingLeft = 6 + depth * 12;
  const dragProps = root ? agentPathDragProps(absolutePath(root, node.path)) : {};

  if (node.isFile) {
    const fileStatus = statusByPath.get(node.path);
    const active = selectedFile === node.path;
    return (
      <button
        className={cn(
          "flex w-full items-center gap-1.5 px-1 py-0.5 text-left text-[12px] hover:bg-muted",
          active && "bg-muted font-medium",
        )}
        onClick={() => onSelectFile(node.path)}
        style={{ paddingLeft }}
        type="button"
        {...dragProps}
      >
        <FileKindIcon path={node.path} />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        {fileStatus ? <StatusBadge file={fileStatus} /> : null}
      </button>
    );
  }

  const Chevron = isOpen ? ChevronDown : ChevronRight;
  const FolderIcon = isOpen ? FolderOpen : Folder;
  return (
    <div>
      <button
        className="flex w-full items-center gap-1 py-0.5 text-left text-[12px] font-medium hover:bg-muted"
        onClick={() => onToggle(node.path)}
        style={{ paddingLeft }}
        type="button"
        {...dragProps}
      >
        <Chevron className="size-3.5 shrink-0 text-muted-foreground" />
        <FolderIcon className="size-3.5 shrink-0 text-amber-600" />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
      </button>
      {isOpen
        ? node.children.map((child) => (
            <TreeRow
              depth={depth + 1}
              expanded={expanded}
              key={child.path}
              node={child}
              onSelectFile={onSelectFile}
              onToggle={onToggle}
              root={root}
              selectedFile={selectedFile}
              statusByPath={statusByPath}
            />
          ))
        : null}
    </div>
  );
}

function StatusBadge({ file }: { file: GitFileStatus }) {
  const letter = file.workingTree.trim() || file.index.trim();
  if (!letter) return null;
  const tone =
    file.index.trim() && !file.workingTree.trim()
      ? "text-emerald-700 dark:text-emerald-400"
      : letter === "?"
        ? "text-amber-700 dark:text-amber-400"
        : "text-zinc-700 dark:text-zinc-300";
  return (
    <span className={cn("ml-1 shrink-0 font-mono text-[10px] font-semibold", tone)}>
      {letter}
    </span>
  );
}
