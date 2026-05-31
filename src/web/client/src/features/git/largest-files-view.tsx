import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Code2,
  Copy,
  FileCode2,
  FileText,
  FileWarning,
  Loader2,
  MoreHorizontal,
  RefreshCw,
} from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useToasts } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { getFileSizeRanking, type FileSizeRank } from "@/lib/api";
import { AgentMark } from "../agent/ai-spark";
import { useAgentDock } from "../agent/chat/agent-context";
import { absolutePath } from "../agent/chat/drag-to-agent";
import { buildLargeFileSplitPrompt } from "../agent/prompts";

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
  root,
}: {
  onOpenFile: (path: string) => void;
  root: string;
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
              <li
                className="group flex items-center gap-3 px-3 transition-colors hover:bg-muted/50"
                key={file.path}
              >
                <span className="w-6 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
                  {index + 1}
                </span>
                <button
                  type="button"
                  onClick={() => onOpenFile(file.path)}
                  className="min-w-0 flex-1 py-1.5 text-left"
                >
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
                <div className="flex shrink-0 items-center justify-end gap-0.5">
                  <LargeFileAiMenu file={file} root={root} />
                  <LargeFileCopyMenu file={file} root={root} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function LargeFileAiMenu({ file, root }: { file: FileSizeRank; root: string }) {
  const { sendToAgent } = useAgentDock();
  const fullPath = absolutePath(root, file.path);
  const fileName = file.path.split("/").pop() ?? file.path;

  function askToSplitFile() {
    sendToAgent({
      prompt: buildLargeFileSplitPrompt({
        absolutePath: fullPath,
        lines: file.lines,
        relativePath: file.path,
      }),
      source: { label: fileName, type: "large-file" },
      label: `Help me split \`${file.path}\` (${file.lines.toLocaleString()} lines).`,
      mode: "send",
    });
  }

  function draftPathForAgent() {
    sendToAgent({
      prompt: fullPath,
      source: { label: fileName, type: "large-file" },
      mode: "draft",
    });
  }

  return (
    <LargeFileActionPopover
      label={`AI actions for ${file.path}`}
      trigger={<AgentMark className="size-3.5" />}
    >
      {(close) => (
        <>
          <ActionMenuButton
            icon={<AgentMark className="size-3.5" />}
            onSelect={() => {
              close();
              askToSplitFile();
            }}
          >
            Ask AI to split this file
          </ActionMenuButton>
          <ActionMenuButton
            icon={<FileCode2 className="size-3.5" />}
            onSelect={() => {
              close();
              draftPathForAgent();
            }}
          >
            Send file path to AI
          </ActionMenuButton>
        </>
      )}
    </LargeFileActionPopover>
  );
}

function LargeFileCopyMenu({ file, root }: { file: FileSizeRank; root: string }) {
  const { error: showErrorToast, success: showSuccessToast } = useToasts();
  const fullPath = absolutePath(root, file.path);
  const fileName = file.path.split("/").pop() ?? file.path;

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      showSuccessToast(`Copied ${label}.`);
    } catch (caught) {
      showErrorToast(caught instanceof Error ? caught.message : `Could not copy ${label}.`);
    }
  }

  return (
    <LargeFileActionPopover
      label={`Copy path for ${file.path}`}
      trigger={
        <>
          <MoreHorizontal className="size-3.5" />
          <span className="sr-only">More actions</span>
        </>
      }
    >
      {(close) => (
        <>
          <ActionMenuButton
            icon={<FileText className="size-3.5" />}
            onSelect={() => {
              close();
              void copy(fileName, "file name");
            }}
          >
            Copy file name
          </ActionMenuButton>
          <ActionMenuButton
            icon={<Copy className="size-3.5" />}
            onSelect={() => {
              close();
              void copy(file.path, "relative path");
            }}
          >
            Copy relative path
          </ActionMenuButton>
          <ActionMenuButton
            icon={<Copy className="size-3.5" />}
            onSelect={() => {
              close();
              void copy(fullPath, "absolute path");
            }}
          >
            Copy absolute path
          </ActionMenuButton>
        </>
      )}
    </LargeFileActionPopover>
  );
}

function LargeFileActionPopover({
  children,
  label,
  trigger,
}: {
  children: (close: () => void) => ReactNode;
  label: string;
  trigger: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ right: 0, top: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  function close() {
    setOpen(false);
  }

  function toggle() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setCoords({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
    setOpen((value) => !value);
  }

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      close();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  return (
    <>
      <button
        aria-label={label}
        className={cn(
          "flex h-7 min-w-7 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-muted-foreground opacity-0 transition-all duration-150 hover:bg-muted hover:text-foreground group-hover:opacity-100",
          open && "bg-muted text-foreground opacity-100",
        )}
        onClick={toggle}
        ref={triggerRef}
        title={label}
        type="button"
      >
        {trigger}
      </button>
      {open
        ? createPortal(
            <div
              className="fixed z-50 w-56 overflow-hidden rounded-md border border-border bg-card p-1 shadow-md"
              ref={menuRef}
              style={{ top: coords.top, right: coords.right }}
            >
              {children(close)}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function ActionMenuButton({
  children,
  icon,
  onSelect,
}: {
  children: ReactNode;
  icon: ReactNode;
  onSelect: () => void;
}) {
  return (
    <button
      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted"
      onClick={onSelect}
      type="button"
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}
