import { useState } from "react";
import { Bot, Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

export function AgentContextPanel({ context }: { context: string }) {
  const [copied, setCopied] = useState(false);

  if (!context) {
    return (
      <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
        No agent context available yet.
      </div>
    );
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(context);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section
      aria-label="Agent context"
      className="rounded-md border border-border bg-muted/30 p-3"
      data-testid="agent-context-panel"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-1.5 text-xs font-medium">
          <Bot className="size-3.5" />
          Agent context
        </h3>
        <Button onClick={copy} size="sm" type="button" variant="outline">
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-background p-3 font-mono text-[11px] leading-relaxed">
        {context}
      </pre>
    </section>
  );
}
