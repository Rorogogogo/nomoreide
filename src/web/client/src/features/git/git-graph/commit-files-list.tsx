import { Alert } from "@/components/ui/alert";
import type { GitFileStatus } from "@/lib/api";

export function CommitFilesList({
  files,
  filesError,
  selectedHash,
  selectedFile,
  onSelect,
}: {
  files: GitFileStatus[];
  filesError: string | null;
  selectedHash: string | null;
  selectedFile: string | null;
  onSelect: (path: string) => void;
}) {
  return (
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
                  onClick={() => onSelect(file.path)}
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
