import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, GitBranch, Minus, Plus } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import type { GitFileStatus } from "@/lib/api";
import { cn } from "@/lib/utils";
import { absolutePath, agentPathDragProps } from "../agent/chat/drag-to-agent";
import { BranchNameBadge } from "./branch-name-badge";
import { FileKindIcon } from "./file-kind-icon";

export interface StagingHandlers {
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  busy: boolean;
}

export function ChangedFilesList({
  branch,
  error,
  files,
  selectedFile,
  onSelectFile,
  root,
  staging,
}: {
  branch?: string;
  error?: string;
  files: GitFileStatus[];
  selectedFile: string;
  onSelectFile: (path: string) => void;
  /** Absolute repo root; lets rows be dragged into the agent dock by path. */
  root?: string;
  /** When provided, rows and section headers expose stage/unstage controls. */
  staging?: StagingHandlers;
}) {
  const groups = useMemo(() => groupFiles(files).filter((group) => group.files.length), [files]);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<ChangeGroupId, boolean>>({
    staged: false,
    unstaged: false,
    untracked: false,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-card/95 px-2.5 py-1.5">
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] font-semibold tracking-tight">
          <GitBranch className="size-3.5" />
          <span className="truncate">Changes</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {branch ? <BranchNameBadge branch={branch} /> : null}
          <Badge variant="secondary">{files.length}</Badge>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {groups.length ? (
          groups.map((group) => (
            <ChangeSection
              collapsed={collapsedGroups[group.id]}
              group={group}
              key={group.id}
              onSelectFile={onSelectFile}
              onToggle={() =>
                setCollapsedGroups((current) => ({
                  ...current,
                  [group.id]: !current[group.id],
                }))
              }
              root={root}
              selectedFile={selectedFile}
              staging={staging}
            />
          ))
        ) : (
          <Alert variant="muted" className="m-3 text-center">
            {error ?? "No changed files."}
          </Alert>
        )}
      </div>
    </div>
  );
}

function ChangeSection({
  collapsed,
  group,
  onSelectFile,
  onToggle,
  root,
  selectedFile,
  staging,
}: {
  collapsed: boolean;
  group: ChangeGroup;
  onSelectFile: (path: string) => void;
  onToggle: () => void;
  root?: string;
  selectedFile: string;
  staging?: StagingHandlers;
}) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const groupPaths = group.files.map((file) => file.path);
  // Staged files can be unstaged; everything else can be staged.
  const bulkAction = staging
    ? group.id === "staged"
      ? { label: "Unstage all", run: () => staging.onUnstage(groupPaths) }
      : { label: "Stage all", run: () => staging.onStage(groupPaths) }
    : null;

  return (
    <section className="border-b border-border last:border-b-0">
      <div className="flex w-full items-center justify-between gap-2 bg-muted/45 px-2 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground hover:bg-muted">
        <button
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          onClick={onToggle}
          type="button"
        >
          <Chevron className="size-3.5" />
          <span className="truncate">{group.label}</span>
        </button>
        {bulkAction ? (
          <button
            className="shrink-0 rounded px-1 text-[10px] font-medium normal-case text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:opacity-50"
            disabled={staging?.busy}
            onClick={bulkAction.run}
            type="button"
          >
            {bulkAction.label}
          </button>
        ) : null}
        <Badge className="min-w-6 justify-center font-mono shadow-none" size="small" variant="outline">
          {group.files.length}
        </Badge>
      </div>
      {collapsed ? null : (
        <div>
          {group.files.map((file) => (
            <FileButton
              active={selectedFile === file.path}
              file={file}
              group={group.id}
              key={file.path}
              onClick={() => onSelectFile(file.path)}
              root={root}
              staging={staging}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function FileButton({
  active,
  file,
  group,
  onClick,
  root,
  staging,
}: {
  active: boolean;
  file: GitFileStatus;
  group: ChangeGroupId;
  onClick: () => void;
  root?: string;
  staging?: StagingHandlers;
}) {
  const filename = file.path.split("/").pop() || file.path;
  const dir = file.path.split("/").slice(0, -1).join("/");
  const dragProps = root ? agentPathDragProps(absolutePath(root, file.path)) : {};
  const staged = group === "staged";
  return (
    <div
      className={cn(
        "group flex w-full items-center gap-1.5 px-1 py-0.5 text-[12px] hover:bg-muted",
        active && "bg-muted font-medium",
      )}
    >
      <button
        aria-label={`Open changed file ${file.path}`}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        onClick={onClick}
        type="button"
        {...dragProps}
      >
        <FileKindIcon path={file.path} />
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5 truncate">
          <span data-testid="changed-file-name" className="shrink-0 truncate">
            {filename}
          </span>
          {dir ? (
            <span
              data-testid="changed-file-dir"
              className="min-w-0 truncate text-muted-foreground"
            >
              {dir}
            </span>
          ) : null}
        </span>
      </button>
      {staging ? (
        <button
          aria-label={`${staged ? "Unstage" : "Stage"} ${file.path}`}
          className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-colors hover:bg-background hover:text-foreground focus:opacity-100 group-hover:opacity-100 disabled:opacity-50"
          disabled={staging.busy}
          onClick={() => (staged ? staging.onUnstage([file.path]) : staging.onStage([file.path]))}
          title={staged ? "Unstage" : "Stage"}
          type="button"
        >
          {staged ? <Minus className="size-3.5" /> : <Plus className="size-3.5" />}
        </button>
      ) : null}
      <span
        className={cn(
          "ml-1 shrink-0 font-mono text-[10px] font-semibold",
          group === "untracked" && "text-amber-700",
          group === "staged" && "text-emerald-700",
          group === "unstaged" && "text-zinc-800",
        )}
      >
        {statusLabel(file, group)}
      </span>
    </div>
  );
}

function statusLabel(file: GitFileStatus, group: ChangeGroupId): string {
  if (group === "untracked") return "?";
  if (group === "staged") return file.index.trim();
  return file.workingTree.trim();
}

type ChangeGroupId = "staged" | "unstaged" | "untracked";

interface ChangeGroup {
  id: ChangeGroupId;
  label: string;
  files: GitFileStatus[];
}

function groupFiles(files: GitFileStatus[]): ChangeGroup[] {
  return [
    {
      id: "unstaged",
      label: "Changes",
      files: files.filter(
        (file) =>
          !(file.index === "?" && file.workingTree === "?") && file.workingTree.trim(),
      ),
    },
    {
      id: "staged",
      label: "Staged Changes",
      files: files.filter(
        (file) =>
          !(file.index === "?" && file.workingTree === "?") &&
          file.index.trim() &&
          !file.workingTree.trim(),
      ),
    },
    {
      id: "untracked",
      label: "Untracked Files",
      files: files.filter((file) => file.index === "?" && file.workingTree === "?"),
    },
  ];
}
