import { useState } from "react";
import { FileDiff, FileWarning } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToasts } from "@/components/ui/toast";
import { startFix, type ErrorIncident } from "@/lib/api";
import { AgentMark } from "../agent/ai-spark";
import { useAgentDock } from "../agent/chat/agent-context";

export function IncidentDetail({
  incident,
  onReviewChanges,
}: {
  incident: ErrorIncident;
  /** Deep-link to Agent → Changes for the session the fix run snapshotted. */
  onReviewChanges?: (sessionId: string) => void;
}) {
  const { error: showErrorToast } = useToasts();
  const { sendToAgent } = useAgentDock();
  const [sending, setSending] = useState(false);
  // Set after a fix is dispatched: the recorded session whose change-set the
  // user can review/revert once the agent finishes editing.
  const [fixedSessionId, setFixedSessionId] = useState<string | null>(null);

  // The AI-native loop: snapshot the working tree, record an agent session, and
  // hand the agent the full repro bundle. Whatever it edits then surfaces as a
  // reviewable, one-click-revertable change-set in Agent → Changes.
  async function fixWithAi() {
    setSending(true);
    try {
      const { prompt, sessionId } = await startFix(incident.id);
      sendToAgent({
        prompt,
        source: { type: "error", label: `${incident.service} — ${incident.level}` },
        label: `Fix this ${incident.level} in \`${incident.service}\`: ${incident.title}`,
      });
      setFixedSessionId(sessionId);
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
            {sending ? "Starting…" : "Fix with AI"}
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
        {fixedSessionId ? (
          <Alert variant="muted" className="mb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs">
                The agent is working on this in the dock. A snapshot was taken first — review or
                undo its edits as one change-set.
              </span>
              {onReviewChanges ? (
                <Button
                  onClick={() => onReviewChanges(fixedSessionId)}
                  size="sm"
                  variant="outline"
                >
                  <FileDiff className="size-3.5" />
                  Review changes
                </Button>
              ) : null}
            </div>
          </Alert>
        ) : null}
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">Log excerpt</p>
        <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
          {incident.logExcerpt.join("\n")}
        </pre>
        <p className="mt-3 text-[11px] text-muted-foreground">
          "Fix with AI" snapshots the working tree, then sends the agent a repro bundle (this error,
          the affected file's diff, recent logs, service state, and masked env) so it can fix it —
          and you can revert the whole change-set if it goes sideways.
        </p>
      </div>
    </div>
  );
}
