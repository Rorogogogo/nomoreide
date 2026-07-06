import { useCallback, useEffect, useState } from "react";
import {
  applyAgentEnvChanges,
  previewAgentEnvChanges,
  type AgentEnvChangePreview,
  type AgentEnvPendingChange,
} from "@/lib/api";
import { useToasts } from "@/components/ui/toast";

function sameChange(a: AgentEnvPendingChange, b: AgentEnvPendingChange): boolean {
  return (
    a.category === b.category &&
    a.action === b.action &&
    a.name === b.name &&
    a.sourceAgent === b.sourceAgent &&
    a.sourceScope === b.sourceScope &&
    a.targetAgent === b.targetAgent &&
    a.targetScope === b.targetScope
  );
}

/**
 * Staged-changes model (ROR-61): actions accumulate locally, the server
 * previews them, and nothing is written until "Save & apply". On a partial
 * failure the un-applied suffix stays staged so the user can retry or drop it.
 */
export function useStagedChanges(onApplied: () => void) {
  const [staged, setStaged] = useState<AgentEnvPendingChange[]>([]);
  const [preview, setPreview] = useState<AgentEnvChangePreview | null>(null);
  const [applying, setApplying] = useState(false);
  const toasts = useToasts();

  const stage = useCallback((change: AgentEnvPendingChange) => {
    setStaged((current) =>
      current.some((existing) => sameChange(existing, change))
        ? current
        : [...current, change],
    );
  }, []);

  const unstage = useCallback((index: number) => {
    setStaged((current) => current.filter((_, position) => position !== index));
  }, []);

  const clear = useCallback(() => setStaged([]), []);

  useEffect(() => {
    if (staged.length === 0) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    previewAgentEnvChanges(staged)
      .then((next) => {
        if (!cancelled) setPreview(next);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setPreview({
          valid: false,
          agents: [],
          items: staged.map((change) => ({
            change,
            ok: false,
            summary: `${change.action} ${change.category} "${change.name}"`,
            warnings: [],
            error: caught instanceof Error ? caught.message : String(caught),
          })),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [staged]);

  const apply = useCallback(async () => {
    if (staged.length === 0 || applying) return;
    setApplying(true);
    try {
      const result = await applyAgentEnvChanges(staged);
      if (result.ok) {
        toasts.success(
          `Applied ${result.applied} change${result.applied === 1 ? "" : "s"} — ${result.backups.length} backup${result.backups.length === 1 ? "" : "s"} written`,
        );
        setStaged([]);
      } else {
        const firstError = result.results.find((entry) => entry.error)?.error;
        toasts.error(
          `Applied ${result.applied} of ${staged.length} changes${firstError ? ` — ${firstError}` : ""}`,
        );
        // Keep whatever was not applied; results follow the staged order.
        setStaged((current) => current.slice(result.applied));
      }
      if (result.applied > 0) onApplied();
    } catch (caught) {
      toasts.error(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setApplying(false);
    }
  }, [applying, onApplied, staged, toasts]);

  return { staged, preview, applying, stage, unstage, clear, apply };
}
