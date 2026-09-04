import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import hljs from "highlight.js/lib/common";
import { Code2, Eye, Pencil, Save, Users, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useToasts } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import {
  getGitBlame,
  getGitFile,
  type GitBlameLine,
  type GitFileContent,
  updateGitFile,
} from "@/lib/api";
import { AiContextTarget } from "../agent/context-menu/ai-context-menu";
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

function NumberedContent({
  blame,
  content,
  focusLine,
  path,
}: {
  /** Provenance per line, or `null` while off or still loading. */
  blame: Map<number, GitBlameLine> | null;
  content: string;
  /** One-based line to scroll to and mark — how a search hit arrives here. */
  focusLine?: number;
  path: string;
}) {
  const language = useMemo(() => languageFor(path), [path]);
  const lines = useMemo(() => highlightLines(content, language), [content, language]);
  /*
    Wide enough for the largest line number *plus* the gutter's own padding.
    `min-width` is border-box here, so a value that counted only the digits
    would be smaller than the padding itself — the number column would collapse
    to nothing and `text-right` would have no box to align inside, which reads
    as the numbers drifting left.
  */
  const gutterWidth = `calc(${Math.max(2, String(lines.length).length)}ch + 1.75rem)`;
  const focusRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Centred rather than merely visible: a hit at the bottom of the viewport
    // reads as the end of the file, which is rarely what it is.
    focusRef.current?.scrollIntoView({ block: "center" });
  }, [focusLine, content]);

  return (
    <div className="min-w-max font-mono text-[12px] leading-[1.5]">
      {lines.map((line, index) => (
        <div
          className={cn("flex", focusLine === index + 1 && "bg-amber-200/30 dark:bg-amber-500/15")}
          key={index}
          ref={focusLine === index + 1 ? focusRef : undefined}
        >
          {blame ? <BlameCell entry={blame.get(index + 1)} /> : null}
          <span
            /*
              No rule and no slab behind the numbers.
              A gutter separated by a border *and* a different background is two
              devices doing one job, and at this type size the pair reads as a
              scrollbar rather than as line numbers. Alignment and a lower
              contrast do it on their own — which is where every editor worth
              copying ended up.
            */
            className="shrink-0 select-none pl-3 pr-4 text-right text-muted-foreground/50"
            style={{ minWidth: gutterWidth }}
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

/**
 * One line's author, in the gutter.
 *
 * Only the *first* line of each run shows a name. Blame repeats the same commit
 * down every line it touched, and printing it on all of them turns the gutter
 * into a wall of one name — the eye then has to find where authorship changes,
 * which is the only thing the column is there to show. Consecutive lines from
 * one commit are left blank, so a change of author is the only thing that draws
 * attention.
 *
 * The run detection lives in the parent's map lookup rather than here; this
 * receives the entry and decides only how to draw it.
 */
function BlameCell({ entry }: { entry?: GitBlameLine & { runStart?: boolean } }) {
  const t = useT();
  if (!entry) {
    return <span className="w-28 shrink-0 select-none" />;
  }
  const label = entry.uncommitted
    ? t("git.blame.short.uncommitted")
    : `${shortAuthor(entry.author)} · ${formatBlameDate(entry.authorTime)}`;
  return (
    <span
      className={cn(
        "w-28 shrink-0 select-none truncate pl-3 pr-2 text-[10px]",
        entry.uncommitted
          ? "text-amber-700 dark:text-amber-500"
          : "text-muted-foreground/70",
        !entry.runStart && "opacity-0",
      )}
      title={
        entry.uncommitted
          ? t("git.blame.uncommitted")
          : `${entry.commit.slice(0, 8)} · ${entry.author} · ${entry.summary}`
      }
    >
      {label}
    </span>
  );
}

/**
 * Short and absolute. "3 months ago" is worse here: the gutter is scanned, and
 * a relative date has to be decoded before it can be compared to the one above.
 *
 * No day. The column sits beside the code it annotates and is competing with it
 * for width — the month and year answer "how old is this line" perfectly well,
 * and the exact date is a hover away.
 */
function formatBlameDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    month: "short",
    year: "2-digit",
  });
}

/**
 * The first word of a name.
 *
 * The column exists to show *where authorship changes*, and a first name does
 * that as well as a full one in a third of the width. The full name, the commit
 * and the summary are all in the title, which is where someone who actually
 * wants them will look.
 */
function shortAuthor(author: string): string {
  return author.split(/\s+/)[0] || author;
}

export function FileViewer({
  path,
  focusLine,
  isModified,
  onViewDiff,
  onFileSaved,
  agentPath,
}: {
  path: string;
  /** One-based line the preview should land on, when a search hit opened this. */
  focusLine?: number;
  isModified: boolean;
  onViewDiff: () => void;
  onFileSaved?: (path: string) => void;
  agentPath?: string;
}) {
  const [file, setFile] = useState<GitFileContent | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const { success: showSuccess, error: showError } = useToasts();
  const t = useT();

  const visualKind = useMemo(() => visualKindFor(path), [path]);
  const [mode, setMode] = useState<ViewMode>("preview");
  const [showBlame, setShowBlame] = useState(false);
  const [blame, setBlame] = useState<GitBlameLine[] | null>(null);
  const [blameError, setBlameError] = useState<string | null>(null);
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

  /**
   * Blame is fetched only while the column is showing.
   *
   * `git blame` walks history for the whole file, so it is far more expensive
   * than reading the file — paying that on every open, for a column most visits
   * never want, would make opening a file feel slow to serve a minority case.
   */
  useEffect(() => {
    if (!showBlame || !path) {
      return;
    }
    let active = true;
    setBlameError(null);
    void getGitBlame(path)
      .then((lines) => {
        if (active) setBlame(lines);
      })
      .catch((caught) => {
        if (active) {
          setBlame(null);
          setBlameError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    return () => {
      active = false;
    };
  }, [path, showBlame]);

  // A different file's blame is not this file's. Cleared on the path rather
  // than left stale behind the toggle, which would blame the wrong lines for
  // as long as the fetch takes.
  useEffect(() => {
    setBlame(null);
    setBlameError(null);
  }, [path]);

  /**
   * Blame by line, with the first line of each commit's run marked.
   *
   * Built here rather than in the row so the whole file is walked once instead
   * of once per rendered line.
   */
  const blameByLine = useMemo(() => {
    if (!blame) return null;
    const map = new Map<number, GitBlameLine & { runStart?: boolean }>();
    let previous: string | null = null;
    for (const entry of blame) {
      map.set(entry.line, { ...entry, runStart: entry.commit !== previous });
      previous = entry.commit;
    }
    return map;
  }, [blame]);

  async function saveDraft() {
    if (!path || !file || !dirty || saving) return;
    setSaving(true);
    try {
      await updateGitFile(path, draft);
      const nextFile = { ...file, content: draft, size: new TextEncoder().encode(draft).length };
      setFile(nextFile);
      setEditing(false);
      showSuccess(t("git.fileViewer.savedToast", { path }));
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
          {t("git.fileViewer.selectFile")}
        </Alert>
      </div>
    );
  }

  return (
    <AiContextTarget
      target={{
        label: path,
        intents: agentPath ? [{
          id: "inspect-file",
          label: t("git.fileViewer.sendPathToAi"),
          resolvePrompt: () =>
            `Inspect this file and explain its responsibilities, relevant risks, and the most useful next action:\n${agentPath}`,
          source: { type: "git-file", label: path },
        }] : [],
      }}
    >
    <section className="flex min-h-0 min-w-0 flex-col border-l border-border bg-card">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-1.5">
        <div className="min-w-0">
          <h2 className="truncate text-[13px] font-semibold tracking-tight">{path}</h2>
          <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
            <span>{t("git.fileViewer.readOnly")}</span>
            {file?.truncated ? (
              <span className="text-amber-700">{t("git.fileViewer.truncated")}</span>
            ) : null}
            {file?.binary ? <span className="text-amber-700">{t("git.fileViewer.binary")}</span> : null}
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
                {t("git.fileViewer.preview")}
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
                {t("git.fileViewer.source")}
              </button>
            </div>
          ) : null}
          {/*
            Only for source. A rendered markdown preview has no lines to blame,
            and offering the toggle there would be a control that does nothing.
          */}
          {mode === "source" && !file?.binary ? (
            <Button
              aria-pressed={showBlame}
              onClick={() => setShowBlame((value) => !value)}
              size="sm"
              type="button"
              variant={showBlame ? "default" : "outline"}
            >
              <Users />
              {t("git.blame.toggle")}
            </Button>
          ) : null}
          {isModified ? (
            <Button onClick={onViewDiff} size="sm" type="button" variant="outline">
              {t("git.fileViewer.viewDiff")}
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
                {t("git.fileViewer.apply")}
              </Button>
              <Button
                disabled={saving}
                onClick={cancelEdit}
                size="sm"
                type="button"
                variant="outline"
              >
                <X />
                {t("common.cancel")}
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
              {t("common.edit")}
            </Button>
          ) : null}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-card">
        {error ? (
          <div className="p-4">
            <Alert variant="destructive">{error}</Alert>
          </div>
        ) : loading ? (
          <div className="p-4 text-[12px] text-muted-foreground">{t("common.loading")}</div>
        ) : file?.binary ? (
          <div className="p-4 text-[12px] text-muted-foreground">
            {t("git.fileViewer.cannotBinary")}
          </div>
        ) : file ? (
          editing ? (
            <Suspense
              fallback={
                <div className="p-4 text-[12px] text-muted-foreground">
                  {t("git.fileViewer.loadingEditor")}
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
            <>
            {showBlame && blameError ? (
              <Alert className="m-3" variant="muted">
                {t("git.blame.unavailable", { error: blameError })}
              </Alert>
            ) : null}
            <NumberedContent
              blame={showBlame ? blameByLine : null}
              content={file.content}
              focusLine={focusLine}
              path={path}
            />
            </>
          )
        ) : null}
      </div>
    </section>
    </AiContextTarget>
  );
}
