import { useState } from "react";
import { Check, ClipboardCopy, FileWarning } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToasts } from "@/components/ui/toast";
import { getErrorPrompt, type ErrorIncident } from "@/lib/api";

export function IncidentDetail({ incident }: { incident: ErrorIncident }) {
  const { error: showErrorToast, success: showSuccessToast } = useToasts();
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copyToAgent() {
    setCopying(true);
    try {
      const { prompt } = await getErrorPrompt(incident.id);
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      showSuccessToast("Copied debugging prompt to clipboard.");
      window.setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      showErrorToast(err instanceof Error ? err.message : String(err));
    } finally {
      setCopying(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Badge
              variant={incident.level === "error" ? "danger" : "secondary"}
              appearance="subtle"
              size="small"
            >
              {incident.level}
            </Badge>
            <span className="truncate font-mono text-xs font-semibold">{incident.service}</span>
            {incident.count > 1 ? (
              <Badge variant="outline" size="small">
                ×{incident.count}
              </Badge>
            ) : null}
          </div>
          <Button onClick={() => void copyToAgent()} disabled={copying} size="sm">
            {copied ? <Check /> : <ClipboardCopy />}
            {copied ? "Copied" : "Copy to agent"}
          </Button>
        </div>
        <p className="mt-1.5 break-words font-mono text-xs text-foreground">{incident.title}</p>
        {incident.file ? (
          <p className="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <FileWarning className="size-3.5" />
            {incident.file}
            {incident.line ? `:${incident.line}` : ""}
          </p>
        ) : null}
        <p className="mt-1 font-mono text-[10px] text-muted-foreground/80">
          first {new Date(incident.firstSeen).toLocaleString()} · last{" "}
          {new Date(incident.lastSeen).toLocaleTimeString()}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">Log excerpt</p>
        <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
          {incident.logExcerpt.join("\n")}
        </pre>
        <p className="mt-3 text-[11px] text-muted-foreground">
          "Copy to agent" bundles this excerpt with the affected file's diff and the last 40 log
          lines.
        </p>
      </div>
    </div>
  );
}
