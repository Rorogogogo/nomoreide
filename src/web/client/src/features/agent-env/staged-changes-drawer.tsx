import { AlertTriangle, Layers, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AgentEnvChangePreview } from "@/lib/api";

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
  if (count === 0) return null;

  return (
    <div className="shrink-0 rounded-lg border border-border bg-card/80 shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold">
          <Layers className="size-3.5 text-muted-foreground" />
          Staged changes
          <Badge size="small" variant="outline">
            {count}
          </Badge>
        </span>
        <div className="flex items-center gap-2">
          <Button disabled={applying} onClick={onClear} size="sm" variant="ghost">
            Clear
          </Button>
          <Button
            disabled={applying || (preview !== null && !preview.valid)}
            onClick={onApply}
            size="sm"
          >
            {applying ? "Applying..." : "Save & apply"}
          </Button>
        </div>
      </div>

      {preview === null ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">Validating staged changes...</p>
      ) : null}

      <ul className="max-h-48 space-y-1 overflow-y-auto p-2">
        {(preview?.items ?? []).map((item, index) => (
          <li
            className="flex items-start gap-2 rounded-md border border-border/60 bg-background/60 px-2 py-1.5"
            key={`${item.summary}-${index}`}
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
              aria-label="Unstage change"
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
