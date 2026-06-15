import { useState } from "react";
import { MarkdownPreview } from "../git/visualizers/markdown-preview";
import { cn } from "@/lib/utils";

/**
 * A GitHub body (PR/issue description) rendered as markdown by default, with a
 * toggle to the raw source. Shared by PR and issue detail so both surfaces read
 * the same. Comments reuse `MarkdownPreview` directly — no toggle needed there.
 */
export function MarkdownBody({
  body,
  title = "Description",
}: {
  body: string;
  title?: string;
}) {
  const [view, setView] = useState<"rendered" | "raw">("rendered");
  const toggleClass = (active: boolean) =>
    cn(
      "rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors",
      active ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
    );

  return (
    <section className="overflow-hidden rounded-md border border-border bg-muted/25">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">{title}</span>
        <div className="flex items-center gap-0.5 rounded-md bg-background/60 p-0.5">
          <button className={toggleClass(view === "rendered")} onClick={() => setView("rendered")} type="button">
            Rendered
          </button>
          <button className={toggleClass(view === "raw")} onClick={() => setView("raw")} type="button">
            Raw
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
