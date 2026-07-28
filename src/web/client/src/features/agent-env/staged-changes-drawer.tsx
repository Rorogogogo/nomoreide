import { AlertTriangle, Layers, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AgentEnvChangePreview } from "@/lib/api";
import { useT } from "@/lib/i18n";

/**
 * Bottom drawer listing staged changes with their server-side preview. Nothing
 * touches an agent config until "Save & apply"; the apply toast reports the
 * backup files written.
 */
export function StagedChangesDrawer({
  count,
  preview,
  applying,
  onUnstage,
  onClear,
  onApply,
}: {
  count: number;
  preview: AgentEnvChangePreview | null;
  applying: boolean;
  onUnstage: (index: number) => void;
  onClear: () => void;
  onApply: () => void;
}) {
  const t = useT();
  if (count === 0) return null;

  return (
    <div className="shrink-0 border-t border-border bg-background">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-card/75 px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold">
          <Layers className="size-3.5 text-muted-foreground" />
          {t("agentEnv.stagedChanges")}
          <Badge size="small" variant="outline">
            {count}
          </Badge>
        </span>
        <div className="flex items-center gap-2">
          <Button disabled={applying} onClick={onClear} size="sm" variant="ghost">
            {t("agentEnv.clear")}
          </Button>
          <Button
            disabled={applying || (preview !== null && !preview.valid)}
            onClick={onApply}
            size="sm"
          >
            {applying ? t("agentEnv.applying") : t("agentEnv.saveApply")}
          </Button>
        </div>
      </div>

      {preview === null ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">{t("agentEnv.validating")}</p>
      ) : null}

      <ul className="max-h-48 divide-y divide-border/60 overflow-y-auto">
        {(preview?.items ?? []).map((item, index) => (
          <li
            className="flex items-start gap-2 px-3 py-2 transition-colors hover:bg-muted/20"
            key={[
              item.change.action,
              item.change.category,
              item.change.sourceAgent,
              item.change.sourceScope,
              item.change.name,
              item.change.targetAgent,
              item.change.targetScope,
            ].join(":")}
          >
            <span className="min-w-0 flex-1">
              <span className={`block text-xs ${item.ok ? "" : "text-destructive"}`}>
                {item.summary}
              </span>
              {item.error ? (
                <span className="block text-[11px] text-destructive">{item.error}</span>
              ) : null}
              {item.warnings.map((warning) => (
                <span
                  className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-500"
                  key={warning}
                >
                  <AlertTriangle className="size-3 shrink-0" />
                  {warning}
                </span>
              ))}
            </span>
            <button
              aria-label={t("agentEnv.unstageAria")}
              className="mt-0.5 text-muted-foreground transition-colors hover:text-foreground"
              disabled={applying}
              onClick={() => onUnstage(index)}
              type="button"
            >
              <X className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>

      {preview && preview.agents.length > 0 ? (
        <div className="flex flex-wrap gap-2 border-t border-border/60 px-3 py-2">
          {preview.agents.map((diff) => (
            <span className="text-[11px] text-muted-foreground" key={diff.agent}>
              <span className="font-medium text-foreground">{diff.agent}</span>
              {diff.add.length > 0 ? ` +${diff.add.length}` : ""}
              {diff.remove.length > 0 ? ` −${diff.remove.length}` : ""}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
