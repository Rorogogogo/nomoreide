import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Database,
  File,
  FileCode2,
  FileText,
  FlaskConical,
  GitBranch,
  Image,
  LockKeyhole,
  Palette,
  Settings2,
  type LucideIcon,
} from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { GitFileStatus } from "@/lib/api";
import { cn } from "@/lib/utils";
import { fileIconKind, type FileIconKind } from "./file-icon-kind";

export function ChangedFilesList({
  branch,
  error,
  files,
  selectedFile,
  onSelectFile,
}: {
  branch?: string;
  error?: string;
  files: GitFileStatus[];
  selectedFile: string;
  onSelectFile: (path: string) => void;
}) {
  const groups = useMemo(() => groupFiles(files).filter((group) => group.files.length), [files]);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<ChangeGroupId, boolean>>({
    staged: false,
    unstaged: false,
    untracked: false,
  });

  return (
    <Card className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-none border-0 bg-transparent">
      <CardHeader className="border-b border-border px-2.5 py-1.5">
        <CardTitle className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <GitBranch className="size-3.5" />
            <span className="truncate">Changes</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {branch ? <Badge variant="outline">{branch}</Badge> : null}
            <Badge variant="secondary">{files.length}</Badge>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 overflow-auto p-0">
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
              selectedFile={selectedFile}
            />
          ))
        ) : (
          <Alert variant="muted" className="m-3 text-center">
            {error ?? "No changed files."}
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

function ChangeSection({
  collapsed,
  group,
  onSelectFile,
  onToggle,
  selectedFile,
}: {
  collapsed: boolean;
  group: ChangeGroup;
  onSelectFile: (path: string) => void;
  onToggle: () => void;
  selectedFile: string;
}) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;

  return (
    <section className="border-b border-border last:border-b-0">
      <button
        className="flex w-full items-center justify-between gap-2 bg-muted/55 px-2.5 py-1 text-left text-[10px] font-semibold uppercase text-muted-foreground hover:bg-muted"
        onClick={onToggle}
        type="button"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <Chevron className="size-3.5" />
          <span className="truncate">{group.label}</span>
        </span>
        <Badge className="min-w-6 justify-center font-mono shadow-none" size="small" variant="outline">
          {group.files.length}
        </Badge>
      </button>
      {collapsed ? null : (
        <div>
          {group.files.map((file) => (
            <FileButton
              active={selectedFile === file.path}
              file={file}
              group={group.id}
              key={file.path}
              onClick={() => onSelectFile(file.path)}
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
}: {
  active: boolean;
  file: GitFileStatus;
  group: ChangeGroupId;
  onClick: () => void;
}) {
  const filename = file.path.split("/").pop() || file.path;
  const dir = file.path.split("/").slice(0, -1).join("/");
  return (
    <Button
      className={cn(
        "grid h-auto w-full grid-cols-[1fr_auto] items-center gap-2 rounded-none border-b border-border px-2.5 py-1.5 text-left",
        active && "bg-muted",
      )}
      onClick={onClick}
      type="button"
      variant="ghost"
    >
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-1.5">
          <FileKindIcon path={file.path} />
          <span className="truncate text-[13px] font-medium">{filename}</span>
        </span>
        {dir ? <span className="block truncate pl-5 text-[10px] text-muted-foreground">{dir}</span> : null}
      </span>
      <span
        className={cn(
          "w-3.5 shrink-0 text-center font-mono text-[11px] font-semibold",
          group === "untracked" && "text-amber-700",
          group === "staged" && "text-emerald-700",
          group === "unstaged" && "text-zinc-800",
        )}
      >
        {statusLabel(file, group)}
      </span>
    </Button>
  );
}

function statusLabel(file: GitFileStatus, group: ChangeGroupId): string {
  if (group === "untracked") return "?";
  if (group === "staged") return file.index.trim();
  return file.workingTree.trim();
}

function FileKindIcon({ path }: { path: string }) {
  const kind = fileIconKind(path);
  const Icon = iconByKind[kind];

  return (
    <Icon
      aria-label={`${kind} file`}
      className={cn("size-3.5 shrink-0", iconClassByKind[kind])}
    />
  );
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
