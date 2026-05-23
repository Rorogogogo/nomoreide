import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Database,
  File,
  FileCode2,
  FileText,
  FlaskConical,
  Folder,
  FolderOpen,
  Image,
  LockKeyhole,
  Palette,
  Settings2,
  type LucideIcon,
} from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import type { GitFileStatus } from "@/lib/api";
import { cn } from "@/lib/utils";
import { fileIconKind, type FileIconKind } from "./file-icon-kind";

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
        dirMap.get(parentPath)!.children.push(node);
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

export function FileTree({
  paths,
  status,
  selectedFile,
  onSelectFile,
  branch,
}: {
  paths: string[];
  status: GitFileStatus[];
  selectedFile: string;
  onSelectFile: (path: string) => void;
  branch?: string;
}) {
  const tree = useMemo(() => buildTree(paths), [paths]);
  const statusByPath = useMemo(() => {
    const map = new Map<string, GitFileStatus>();
    for (const file of status) map.set(file.path, file);
    return map;
  }, [status]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ "": true });
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (seeded || tree.children.length === 0) return;
    const out: Record<string, boolean> = { "": true };
    for (const child of tree.children) {
      if (!child.isFile) out[child.path] = true;
    }
    setExpanded(out);
    setSeeded(true);
  }, [seeded, tree.children]);

  function toggle(path: string) {
    setExpanded((current) => ({ ...current, [path]: !current[path] }));
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-card/95 px-2.5 py-1.5">
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] font-semibold tracking-tight">
          <Folder className="size-3.5" />
          <span className="truncate">Files</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {branch ? <Badge variant="outline">{branch}</Badge> : null}
          <Badge variant="secondary">{paths.length}</Badge>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {tree.children.length === 0 ? (
          <Alert variant="muted" className="m-3 text-center">
            No tracked files.
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
  selectedFile,
  statusByPath,
}: {
  depth: number;
  expanded: Record<string, boolean>;
  node: TreeNode;
  onSelectFile: (path: string) => void;
  onToggle: (path: string) => void;
  selectedFile: string;
  statusByPath: Map<string, GitFileStatus>;
}) {
  const isOpen = expanded[node.path] ?? false;
  const paddingLeft = 6 + depth * 12;

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
      ? "text-emerald-700"
      : letter === "?"
        ? "text-amber-700"
        : "text-zinc-700";
  return (
    <span className={cn("ml-1 shrink-0 font-mono text-[10px] font-semibold", tone)}>
      {letter}
    </span>
  );
}

function FileKindIcon({ path }: { path: string }) {
  const kind = fileIconKind(path);
  const Icon = iconByKind[kind];
  return <Icon className={cn("size-3.5 shrink-0", iconClassByKind[kind])} />;
}

const iconByKind: Record<FileIconKind, LucideIcon> = {
  code: FileCode2,
  config: Settings2,
  data: Database,
  document: FileText,
  generic: File,
  image: Image,
  lock: LockKeyhole,
  style: Palette,
  test: FlaskConical,
};

const iconClassByKind: Record<FileIconKind, string> = {
  code: "text-sky-600",
  config: "text-zinc-600",
  data: "text-emerald-700",
  document: "text-blue-700",
  generic: "text-muted-foreground",
  image: "text-fuchsia-700",
  lock: "text-amber-700",
  style: "text-rose-700",
  test: "text-violet-700",
};

