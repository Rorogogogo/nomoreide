import hljs from "highlight.js/lib/common";
import { useEffect, useMemo, useRef } from "react";
import type { GitBlameLine } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Rendering one file's text: which language it is, how it highlights, and the
 * blame column beside the line numbers.
 *
 * Split from `file-viewer.tsx`, which owns loading, editing and saving. The
 * highlighting escapes its input before inserting it, because a file's own
 * contents reach `dangerouslySetInnerHTML` from here.
 */

export type VisualKind = "markdown" | "yaml";

/** Files that support a rendered "Preview" mode alongside the raw source. */
export function visualKindFor(path: string): VisualKind | null {
  const ext = path.split("/").pop()?.toLowerCase().split(".").pop() ?? "";
  if (ext === "md" || ext === "mdx" || ext === "markdown") return "markdown";
  if (ext === "yml" || ext === "yaml") return "yaml";
  return null;
}

export type ViewMode = "source" | "preview";

export function languageFor(path: string): string | null {
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

export function highlightLines(content: string, language: string | null): string[] {
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

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function NumberedContent({
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
export function BlameCell({ entry }: { entry?: GitBlameLine & { runStart?: boolean } }) {
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
export function formatBlameDate(seconds: number): string {
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
export function shortAuthor(author: string): string {
  return author.split(/\s+/)[0] || author;
}

