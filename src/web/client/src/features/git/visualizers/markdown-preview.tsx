import { useEffect, useMemo, useRef } from "react";
import { marked } from "marked";
import hljs from "highlight.js/lib/common";
import "../file-viewer-theme.css";
import "./markdown-preview.css";

/**
 * Minimal HTML sanitizer for rendered markdown. This viewer only ever shows
 * tracked files from the user's own repo, but raw HTML embedded in markdown
 * still passes through `marked`, so we strip the obvious script vectors:
 * <script>/<style> blocks, inline `on*` handlers, and `javascript:` URLs.
 */
function sanitize(html: string): string {
  return html
    .replace(/<\/?(script|style|iframe|object|embed)\b[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1=$2#$2');
}

export function MarkdownPreview({ content }: { content: string }) {
  const html = useMemo(() => {
    const parsed = marked.parse(content, { async: false, gfm: true, breaks: false });
    return sanitize(parsed as string);
  }, [content]);

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.querySelectorAll<HTMLElement>("pre code").forEach((block) => {
      hljs.highlightElement(block);
    });
  }, [html]);

  return (
    <div
      ref={containerRef}
      className="md-preview min-w-0 px-6 py-5"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized above
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
