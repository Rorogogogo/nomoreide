import { useMemo } from "react";
import { marked } from "marked";
import "./chat-markdown.css";

/**
 * Minimal HTML sanitizer for agent-authored markdown. The dock renders text the
 * agent streams back, so we strip the obvious script vectors before injecting
 * it: <script>/<style>/embeds, inline `on*` handlers, and `javascript:` URLs.
 * Mirrors the file-preview sanitizer so both rendered-markdown surfaces are safe.
 */
function sanitize(html: string): string {
  return html
    .replace(/<\/?(script|style|iframe|object|embed)\b[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1=$2#$2');
}

/**
 * Renders an agent chat message as markdown: `**bold**`, `## headings`,
 * `` `code` ``, lists, links, etc. `breaks: true` keeps the line-by-line feel
 * chat users expect (single newlines become <br>), unlike strict markdown.
 */
export function ChatMarkdown({ content }: { content: string }) {
  const html = useMemo(() => {
    const parsed = marked.parse(content, { async: false, gfm: true, breaks: true });
    return sanitize(parsed as string);
  }, [content]);

  return (
    <div
      className="chat-md"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized above
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
