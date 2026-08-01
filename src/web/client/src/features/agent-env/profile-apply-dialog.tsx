import { AlertTriangle, Download } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { PendingProfileApply } from "./use-profiles";
import { AGENT_LABELS } from "./agent-column";
import { useT } from "@/lib/i18n";

/**
 * Conflict preview before a profile apply. Conflicting items start unchecked
 * (skipped) so confirming never silently overwrites the agent's existing
 * config; the user opts in per item.
 */
export function ProfileApplyDialog({
  pending,
  busy,
  onToggle,
  onConfirm,
  onCancel,
}: {
  pending: PendingProfileApply;
  busy: boolean;
  onToggle: (key: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const { preview, skipped } = pending;
  const applyCount = preview.items.filter(
    (item) => !skipped.has(`${item.category}:${item.id ?? item.name}`),
  ).length;

  return (
    <ConfirmDialog
      confirmLabel={busy ? t("agentEnv.applying") : t(applyCount === 1 ? "agentEnv.applyCountOne" : "agentEnv.applyCountMany", { count: applyCount })}
      icon={<Download />}
      loading={busy}
      message={
        <div className="space-y-2">
          <p>
            {t("agentEnv.applyBodyPre")}
            <span className="font-medium text-foreground">{preview.profile}</span>
            {t("agentEnv.applyBodyPost", { name: AGENT_LABELS[preview.agent] })}
          </p>
          <ul className="max-h-56 space-y-1 overflow-y-auto">
            {preview.items.map((item) => {
              const key = `${item.category}:${item.id ?? item.name}`;
              return (
                <li className="flex items-start gap-2" key={key}>
                  <input
                    checked={!skipped.has(key)}
                    className="mt-0.5"
                    disabled={busy}
                    id={`apply-${key}`}
                    onChange={() => onToggle(key)}
                    type="checkbox"
                  />
                  <label className="min-w-0 flex-1 cursor-pointer" htmlFor={`apply-${key}`}>
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-xs text-foreground">
                        {item.category === "mcp"
                          ? t("agentEnv.itemMcp")
                          : item.category === "plugin"
                            ? t("agentEnv.itemPlugin")
                            : t("agentEnv.itemSkill")} {item.name}
                      </span>
                      <Badge
                        size="small"
                        variant={
                          item.status === "conflict"
                            ? "warning"
                            : item.status === "identical"
                              ? "outline"
                              : "success"
                        }
                      >
                        {item.status === "conflict"
                          ? t("agentEnv.statusOverwrites")
                          : item.status === "identical"
                            ? t("agentEnv.statusIdentical")
                            : t("agentEnv.statusNew")}
                      </Badge>
                    </span>
                    {item.warnings.map((warning) => (
                      <span
                        className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-500"
                        key={warning}
                      >
                        <AlertTriangle className="size-3 shrink-0" />
                        {warning}
                      </span>
                    ))}
                  </label>
                </li>
              );
            })}
          </ul>
          {preview.unresolvedCredentials.length > 0 ? (
            <p className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-500">
              <AlertTriangle className="size-3 shrink-0" />
              {t("agentEnv.unfilledCredentials")}
              {preview.unresolvedCredentials.join(", ")}
            </p>
          ) : null}
        </div>
      }
      onCancel={onCancel}
      onConfirm={onConfirm}
      title={t("agentEnv.applyProfileTitle", { name: AGENT_LABELS[preview.agent] })}
      tone="success"
    />
  );
}
