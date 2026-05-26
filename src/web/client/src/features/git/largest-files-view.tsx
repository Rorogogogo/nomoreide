import { useEffect, useMemo, useState } from "react";
import { Code2, FileWarning, Loader2, RefreshCw } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getFileSizeRanking, type FileSizeRank } from "@/lib/api";

// Tracks the ~300 line/file soft budget called out in CLAUDE.md.
const WARN_LINES = 300;
const DANGER_LINES = 600;

// Docs/data/config/assets/lockfiles are *meant* to be long — flagging them as a
// code smell is noise, so "Code only" filters them out by extension.
const NON_CODE_EXTENSIONS = new Set([
  "md", "mdx", "markdown", "txt", "rst", "adoc",
  "json", "jsonc", "json5", "yaml", "yml", "toml", "xml", "ini", "cfg", "conf", "env", "properties",
  "csv", "tsv", "lock",
  "svg", "map", "snap", "png", "jpg", "jpeg", "gif", "ico", "webp",
]);

/** True for hand-written source — the only files where length is a real smell. */
function isSourceFile(path: string): boolean {
  const lower = path.toLowerCase();
  // Generated artifacts aren't hand-maintained, so length doesn't matter.
  if (lower.endsWith(".d.ts") || lower.endsWith(".min.js") || lower.endsWith(".min.css")) {
    return false;
  }
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return true; // extensionless (Dockerfile, Makefile) → treat as code
  return !NON_CODE_EXTENSIONS.has(lower.slice(dot + 1));
}

type Band = "ok" | "warn" | "danger";

function bandFor(lines: number): Band {
  if (lines >= DANGER_LINES) return "danger";
  if (lines >= WARN_LINES) return "warn";
  return "ok";
}

const BAR_CLASS: Record<Band, string> = {
  ok: "bg-emerald-500/60",
  warn: "bg-amber-500/70",
  danger: "bg-destructive/70",
};

const TEXT_CLASS: Record<Band, string> = {
  ok: "text-muted-foreground",
  warn: "text-amber-600 dark:text-amber-400",
  danger: "text-destructive",
};

/**
 * Ranks every tracked file by line count so over-long files (a maintenance
 * smell) surface at the top. Loads lazily — only mounted when its tab is open.
 */
export function LargestFilesView({
  onOpenFile,
}: {
  onOpenFile: (path: string) => void;
}) {
  const [files, setFiles] = useState<FileSizeRank[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [codeOnly, setCodeOnly] = useState(true);

  function load() {
    setLoading(true);
    setError(null);
    getFileSizeRanking()
      .then(setFiles)
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setLoading(false));
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once on mount
  useEffect(() => {
    load();
  }, []);

  const visible = useMemo(
    () => (codeOnly ? files.filter((file) => isSourceFile(file.path)) : files),
    [files, codeOnly],
  );
  const hidden = files.length - visible.length;
  const maxLines = visible[0]?.lines ?? 1;
  const overBudget = visible.filter((file) => file.lines >= WARN_LINES).length;

  return (
    <div className="flex h-full min-h-0 flex-col bg-card/85">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <FileWarning className="size-4" />
          <span className="font-semibold text-foreground">Largest files</span>
          {!loading && !error ? (
            <span>
              {visible.length} files · {overBudget} over {WARN_LINES} lines
              {codeOnly && hidden > 0 ? ` · ${hidden} data/docs hidden` : ""}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant={codeOnly ? "default" : "outline"}
            className="h-7"
            onClick={() => setCodeOnly((value) => !value)}
            title="Hide docs, data, config and generated files"
            type="button"
          >
            <Code2 />
            Code only
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            onClick={load}
            disabled={loading}
            type="button"
          >
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Refresh
          </Button>
        </div>
      </div>

      {error ? (
        <Alert variant="destructive" className="m-3">
          {error}
        </Alert>
      ) : loading && files.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />
          Scanning tracked files…
        </div>
      ) : visible.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {files.length === 0
            ? "No tracked text files found."
            : "No code files — toggle off “Code only” to see data & docs."}
        </div>
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-border/60 overflow-auto">
          {visible.map((file, index) => {
            const band = bandFor(file.lines);
            return (
              <li key={file.path}>
                <button
                  type="button"
                  onClick={() => onOpenFile(file.path)}
                  className="group flex w-full items-center gap-3 px-3 py-1.5 text-left transition-colors hover:bg-muted/50"
                >
                  <span className="w-6 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate font-mono text-[11px]">{file.path}</span>
                      <span className={cn("shrink-0 font-mono text-[11px] tabular-nums", TEXT_CLASS[band])}>
                        {file.truncated ? "≥" : ""}
                        {file.lines.toLocaleString()} lines
                      </span>
                    </div>
                    <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn("h-full rounded-full", BAR_CLASS[band])}
                        style={{ width: `${Math.max(2, (file.lines / maxLines) * 100)}%` }}
                      />
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
