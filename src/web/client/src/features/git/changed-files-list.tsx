import { FileCode2, GitBranch } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { GitFileStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

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
  return (
    <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <CardHeader className="border-b border-border p-3">
        <CardTitle className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2">
            <GitBranch className="size-4" />
            <span className="truncate">Changes</span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {branch ? <Badge variant="outline">{branch}</Badge> : null}
            <Badge variant="secondary">{files.length}</Badge>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 overflow-auto p-0">
        {files.length ? (
          files.map((file) => (
            <FileButton
              active={selectedFile === file.path}
              file={file}
              key={file.path}
              onClick={() => onSelectFile(file.path)}
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

function FileButton({
  active,
  file,
  onClick,
}: {
  active: boolean;
  file: GitFileStatus;
  onClick: () => void;
}) {
  const filename = file.path.split("/").pop() || file.path;
  const dir = file.path.split("/").slice(0, -1).join("/");
  return (
    <Button
      className={cn(
        "grid h-auto w-full grid-cols-[1fr_auto] items-center gap-3 rounded-none border-b border-border px-4 py-3 text-left",
        active && "bg-muted",
      )}
      onClick={onClick}
      type="button"
      variant="ghost"
    >
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <FileCode2 className="size-4 shrink-0 text-accent" />
          <span className="truncate font-medium">{filename}</span>
        </span>
        {dir ? <span className="block truncate pl-6 text-xs text-muted-foreground">{dir}</span> : null}
      </span>
      <Badge variant="warning" className="font-mono">
        {(file.index + file.workingTree).trim()}
      </Badge>
    </Button>
  );
}
