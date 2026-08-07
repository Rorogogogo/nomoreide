import { useState } from "react";
import { MarkdownPreview } from "../git/visualizers/markdown-preview";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * A GitHub body (PR/issue description) rendered as markdown by default, with a
 * toggle to the raw source. Shared by PR and issue detail so both surfaces read
 * the same. Comments reuse `MarkdownPreview` directly — no toggle needed there.
 */
export function MarkdownBody({
  body,
  title,
}: {
  body: string;
  title?: string;
}) {
  const t = useT();
  const resolvedTitle = title ?? t("github.md.description");
  const [view, setView] = useState<"rendered" | "raw">("rendered");
  const toggleClass = (active: boolean) =>
    cn(
      "rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      active ? "bg-background text-foreground" : "text-muted-foreground hover:text-foreground",
    );

  // Not a card: the body is the tail of a continuous read down the PR/issue,
  // so a title row over a hairline separates it without boxing it in.
  return (
    <section>
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">{resolvedTitle}</span>
        <div className="flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5">
          <button className={toggleClass(view === "rendered")} onClick={() => setView("rendered")} type="button">
            {t("github.md.rendered")}
          </button>
          <button className={toggleClass(view === "raw")} onClick={() => setView("raw")} type="button">
            {t("github.md.raw")}
          </button>
        </div>
      </div>
      {view === "rendered" ? (
        <MarkdownPreview content={body} />
      ) : (
        <pre className="overflow-x-auto whitespace-pre-wrap px-3 py-3 font-mono text-[12px]">{body}</pre>
      )}
    </section>
  );
}
