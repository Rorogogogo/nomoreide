import { useState } from "react";
import { FileWarning } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToasts } from "@/components/ui/toast";
import { getErrorPrompt, type ErrorIncident } from "@/lib/api";
import { AgentMark } from "../agent/ai-spark";
import { useAgentDock } from "../agent/chat/agent-context";

export function IncidentDetail({ incident }: { incident: ErrorIncident }) {
  const { error: showErrorToast } = useToasts();
  const { sendToAgent } = useAgentDock();
  const [sending, setSending] = useState(false);

  // The AI-native path: build the debugging prompt (log excerpt + the affected
  // file's diff + recent logs) and hand it straight to the dock so the agent
  // can start working on it.
  async function fixWithAi() {
    setSending(true);
    try {
      const { prompt } = await getErrorPrompt(incident.id);
      sendToAgent({
        prompt,
        source: { type: "error", label: `${incident.service} — ${incident.level}` },
        label: `Help me debug this ${incident.level} in \`${incident.service}\`: ${incident.title}`,
      });
    } catch (err) {
      showErrorToast(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
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
          <Button
            onClick={() => void fixWithAi()}
            disabled={sending}
            size="sm"
            variant="outline"
          >
            <AgentMark className="size-3.5" />
            {sending ? "Sending…" : "Fix with AI"}
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
          "Fix with AI" sends the agent this excerpt with the affected file's diff and the last 40
          log lines, so it can start debugging right away.
        </p>
      </div>
    </div>
  );
}
