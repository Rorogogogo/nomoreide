import { useState } from "react";
import { FileDiff, FileWarning } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useOperations } from "@/components/operations/operation-context";
import { useT } from "@/lib/i18n";
import { getErrorPrompt, startFix, type ErrorIncident } from "@/lib/api";
import { AiContextTarget } from "../agent/context-menu/ai-context-menu";

export function IncidentDetail({
  detailId,
  incident,
  onReviewChanges,
}: {
  detailId?: string;
  incident: ErrorIncident;
  /** Deep-link to Agent → Changes for the session the fix run snapshotted. */
  onReviewChanges?: (sessionId: string) => void;
}) {
  const t = useT();
  const { isPending, runOperation } = useOperations();
  const operationKey = `error:${incident.id}:fix`;
  const fixing = isPending(operationKey);
  // Set after a fix is dispatched: the recorded session whose change-set the
  // user can review/revert once the agent finishes editing.
  const [fixedSessionId, setFixedSessionId] = useState<string | null>(null);

  async function prepareFixPrompt() {
    const result = await runOperation(
      {
        errorMessage: (error) =>
          error instanceof Error ? error.message : String(error),
        key: operationKey,
        label: t("errors.incident.fixingOperation", {
          service: incident.service,
        }),
      },
      async () => {
        const { prompt, sessionId } = await startFix(incident.id);
        setFixedSessionId(sessionId);
        return prompt;
      },
    );
    if (!result) throw new Error(t("agent.contextMenu.failed"));
    return result;
  }

  return (
    <AiContextTarget
      target={{
        label: incident.title,
        intents: [{
          id: "fix-incident",
          label: t("errors.incident.fixWithAi"),
          resolvePrompt: async (delivery) =>
            delivery === "send"
              ? prepareFixPrompt()
              : (await getErrorPrompt(incident.id)).prompt,
          reportError: (delivery) => delivery === "copy",
          source: { type: "error", label: `${incident.service} — ${incident.level}` },
          agentLabel: t("errors.incident.fixLabel", {
            level: incident.level,
            service: incident.service,
            title: incident.title,
          }),
        }],
      }}
    >
    <div
      className="min-w-0 rounded-lg border border-border bg-background"
      data-incident-detail="true"
      id={detailId}
    >
      <div className="px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Badge
              variant={incident.level === "error" ? "danger" : "secondary"}
              appearance="subtle"
              size="small"
            >
              {t(
                incident.level === "error"
                  ? "errors.level.error"
                  : "errors.level.warning",
              )}
            </Badge>
            <span className="truncate font-mono text-xs font-semibold">{incident.service}</span>
            {incident.count > 1 ? (
              <Badge variant="outline" size="small">
                ×{incident.count}
              </Badge>
            ) : null}
          </div>
          {fixing ? <span className="text-xs text-muted-foreground">{t("errors.incident.starting")}</span> : null}
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
          {t("errors.incident.firstLast", {
            first: new Date(incident.firstSeen).toLocaleString(),
            last: new Date(incident.lastSeen).toLocaleTimeString(),
          })}
        </p>
      </div>

      <div className="border-t border-border p-4">
        {fixedSessionId ? (
          <Alert variant="muted" className="mb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs">{t("errors.incident.working")}</span>
              {onReviewChanges ? (
                <Button
                  onClick={() => onReviewChanges(fixedSessionId)}
                  size="sm"
                  variant="outline"
                >
                  <FileDiff className="size-3.5" />
                  {t("errors.incident.reviewChanges")}
                </Button>
              ) : null}
            </div>
          </Alert>
        ) : null}
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t("errors.incident.logExcerpt")}</p>
        <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
          {incident.logExcerpt.join("\n")}
        </pre>
        <p className="mt-3 text-[11px] text-muted-foreground">{t("errors.incident.explain")}</p>
      </div>
    </div>
    </AiContextTarget>
  );
}
