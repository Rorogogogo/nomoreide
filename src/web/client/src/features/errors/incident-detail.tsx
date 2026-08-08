import { useState } from "react";
import { FileDiff } from "lucide-react";
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
    {/* Lines, not boxes: this is a region of the table, not a floating card,
        and the row above already carries level / service / count / file — so
        the detail adds only what the row had to truncate or omit. */}
    <div
      className="min-w-0 border-t border-border bg-muted/10"
      data-incident-detail="true"
      id={detailId}
    >
      <div className="px-3 py-2">
        <p className="break-words font-mono text-[12px] text-foreground">{incident.title}</p>
        <p className="mt-1 font-mono text-[10px] text-muted-foreground">
          {incident.file
            ? `${incident.file}${incident.line ? `:${incident.line}` : ""} · `
            : ""}
          {t("errors.incident.firstLast", {
            first: new Date(incident.firstSeen).toLocaleString(),
            last: new Date(incident.lastSeen).toLocaleTimeString(),
          })}
        </p>
      </div>

      {fixedSessionId ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2">
          <span className="text-[11px] text-muted-foreground">{t("errors.incident.working")}</span>
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
      ) : null}

      <div className="flex items-center justify-between gap-2 border-y border-border bg-muted/20 px-3 py-1">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {t("errors.incident.logExcerpt")}
        </span>
        {fixing ? (
          <span className="text-[10px] text-muted-foreground">{t("errors.incident.starting")}</span>
        ) : null}
      </div>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-[11px] leading-relaxed">
        {incident.logExcerpt.join("\n")}
      </pre>
      <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
        {t("errors.incident.explain")}
      </p>
    </div>
    </AiContextTarget>
  );
}
