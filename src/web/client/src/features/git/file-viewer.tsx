import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import hljs from "highlight.js/lib/common";
import { Code2, Eye, Pencil, Save, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useToasts } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { getGitFile, type GitFileContent, updateGitFile } from "@/lib/api";
import { AgentMark } from "../agent/ai-spark";
import { MarkdownPreview } from "./visualizers/markdown-preview";
import { YamlTree } from "./visualizers/yaml-tree";
import "./file-viewer-theme.css";

const CodeEditor = lazy(() =>
  import("./code-editor").then((module) => ({ default: module.CodeEditor })),
);

type VisualKind = "markdown" | "yaml";

/** Files that support a rendered "Preview" mode alongside the raw source. */
function visualKindFor(path: string): VisualKind | null {
  const ext = path.split("/").pop()?.toLowerCase().split(".").pop() ?? "";
  if (ext === "md" || ext === "mdx" || ext === "markdown") return "markdown";
  if (ext === "yml" || ext === "yaml") return "yaml";
  return null;
}

type ViewMode = "source" | "preview";

function languageFor(path: string): string | null {
  const filename = path.split("/").pop()?.toLowerCase() ?? "";
  const ext = filename.includes(".") ? filename.split(".").pop() ?? "" : "";
  const byExt: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    h: "c",
    cpp: "cpp",
    cc: "cpp",
    hpp: "cpp",
    cs: "csharp",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "ini",
    ini: "ini",
    md: "markdown",
    mdx: "markdown",
    css: "css",
    scss: "scss",
    less: "less",
    html: "xml",
    xml: "xml",
    sql: "sql",
    dockerfile: "dockerfile",
  };
  if (byExt[ext]) return byExt[ext];
  if (filename === "dockerfile") return "dockerfile";
  return null;
}

function highlightLines(content: string, language: string | null): string[] {
  // Strip a single trailing newline so we don't render a phantom blank row.
  const trimmed = content.endsWith("\n") ? content.slice(0, -1) : content;
  if (!language || !hljs.getLanguage(language)) {
    return trimmed.split("\n").map(escapeHtml);
  }
  // Highlight per line. Cross-line state (multi-line strings/comments) won't
  // carry, but it's robust against malformed nested span splitting.
  return trimmed.split("\n").map((line) => {
    if (!line) return "";
    try {
      return hljs.highlight(line, { language, ignoreIllegals: true }).value;
    } catch {
      return escapeHtml(line);
    }
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function NumberedContent({ content, path }: { content: string; path: string }) {
  const language = useMemo(() => languageFor(path), [path]);
  const lines = useMemo(() => highlightLines(content, language), [content, language]);
  const gutterWidth = `${Math.max(2, String(lines.length).length)}ch`;
  return (
    <div className="min-w-max font-mono text-[12px] leading-[1.5]">
      {lines.map((line, index) => (
        <div className="flex" key={index}>
          <span
            className="shrink-0 select-none border-r border-zinc-200 bg-zinc-100 px-2 text-right text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-500"
            style={{ minWidth: `calc(${gutterWidth} + 1rem)` }}
          >
            {index + 1}
          </span>
          <span
            className="hljs whitespace-pre px-3 text-zinc-800 dark:text-zinc-100"
            dangerouslySetInnerHTML={{ __html: line || " " }}
          />
        </div>
      ))}
    </div>
  );
}

export function FileViewer({
  path,
  isModified,
  onViewDiff,
  onFileSaved,
  onSendToAi,
}: {
  path: string;
  isModified: boolean;
  onViewDiff: () => void;
  onFileSaved?: (path: string) => void;
  onSendToAi?: () => void;
}) {
  const [file, setFile] = useState<GitFileContent | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const { success: showSuccess, error: showError } = useToasts();

  const visualKind = useMemo(() => visualKindFor(path), [path]);
  const [mode, setMode] = useState<ViewMode>("preview");
  const canEdit = Boolean(file && !file.binary && !file.truncated);
  const dirty = file ? draft !== file.content : false;

  // Default to the rendered preview whenever the selected file supports one.
  useEffect(() => {
    setMode(visualKind ? "preview" : "source");
    setEditing(false);
  }, [visualKind]);

  useEffect(() => {
    if (!path) {
      setFile(null);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    setEditing(false);
    void getGitFile(path)
      .then((next) => {
        if (active) {
          setFile(next);
          setDraft(next.content);
          setLoading(false);
        }
      })
      .catch((caught) => {
        if (active) {
          setError(caught instanceof Error ? caught.message : String(caught));
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [path]);

  async function saveDraft() {
    if (!path || !file || !dirty || saving) return;
    setSaving(true);
    try {
      await updateGitFile(path, draft);
      const nextFile = { ...file, content: draft, size: new TextEncoder().encode(draft).length };
      setFile(nextFile);
      setEditing(false);
      showSuccess(`Saved ${path}.`);
      onFileSaved?.(path);
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  function cancelEdit() {
    setDraft(file?.content ?? "");
    setEditing(false);
  }

  if (!path) {
    return (
      <div className="p-4">
        <Alert variant="muted" className="border-dashed p-12 text-center">
          Select a file to view its contents.
        </Alert>
      </div>
    );
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-col border-l border-border bg-card">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-1.5">
        <div className="min-w-0">
          <h2 className="truncate text-[13px] font-semibold tracking-tight">{path}</h2>
          <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
            <span>Read-only view of tracked file.</span>
            {file?.truncated ? (
              <span className="text-amber-700">Truncated — file exceeds 1MB.</span>
            ) : null}
            {file?.binary ? <span className="text-amber-700">Binary file.</span> : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {visualKind && !file?.binary ? (
            <div className="flex items-center rounded-md border border-border p-0.5">
              <button
                type="button"
                onClick={() => setMode("preview")}
                aria-pressed={mode === "preview"}
                className={cn(
                  "flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors",
                  mode === "preview"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted",
                )}
              >
                <Eye className="size-3.5" />
                Preview
              </button>
              <button
                type="button"
                onClick={() => setMode("source")}
                aria-pressed={mode === "source"}
                className={cn(
                  "flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors",
                  mode === "source"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted",
                )}
              >
                <Code2 className="size-3.5" />
                Source
              </button>
            </div>
          ) : null}
          {isModified ? (
            <Button onClick={onViewDiff} size="sm" type="button" variant="outline">
              View diff
            </Button>
          ) : null}
          {onSendToAi ? (
            <Button
              aria-label="Send file to AI input"
              className="size-8"
              disabled={!path}
              onClick={onSendToAi}
              size="icon"
              title="Send file path to AI input"
              type="button"
              variant="outline"
            >
              <AgentMark className="size-4" />
            </Button>
          ) : null}
          {editing ? (
            <>
              <Button
                disabled={!dirty || saving}
                onClick={() => void saveDraft()}
                size="sm"
                type="button"
              >
                <Save />
                Apply
              </Button>
              <Button
                disabled={saving}
                onClick={cancelEdit}
                size="sm"
                type="button"
                variant="outline"
              >
                <X />
                Cancel
              </Button>
            </>
          ) : canEdit ? (
            <Button
              onClick={() => {
                setMode("source");
                setEditing(true);
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              <Pencil />
              Edit
            </Button>
          ) : null}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-zinc-50 dark:bg-zinc-950">
        {error ? (
          <div className="p-4">
            <Alert variant="destructive">{error}</Alert>
          </div>
        ) : loading ? (
          <div className="p-4 text-[12px] text-muted-foreground">Loading…</div>
        ) : file?.binary ? (
          <div className="p-4 text-[12px] text-muted-foreground">
            Cannot display binary content.
          </div>
        ) : file ? (
          editing ? (
            <Suspense
              fallback={
                <div className="p-4 text-[12px] text-muted-foreground">
                  Loading editor…
                </div>
              }
            >
              <CodeEditor path={path} value={draft} onChange={setDraft} />
            </Suspense>
          ) : visualKind && mode === "preview" ? (
            visualKind === "markdown" ? (
              <MarkdownPreview content={file.content} />
            ) : (
              <YamlTree content={file.content} />
            )
          ) : (
            <NumberedContent content={file.content} path={path} />
          )
        ) : null}
      </div>
    </section>
  );
}
