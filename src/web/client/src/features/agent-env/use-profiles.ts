import { useCallback, useEffect, useState } from "react";
import {
  applyAgentEnvProfile,
  deleteAgentEnvProfile,
  exportAgentEnvProfile,
  importAgentEnvProfile,
  listAgentEnvProfiles,
  previewAgentEnvProfileApply,
  snapshotAgentEnvProfile,
  type AgentEnvAgentName,
  type AgentEnvProfileApplyPreview,
  type AgentEnvProfileSummary,
} from "@/lib/api";
import { useToasts } from "@/components/ui/toast";

export interface PendingProfileApply {
  preview: AgentEnvProfileApplyPreview;
  /** Item keys (`mcp:<name>` / `skill:<name>`) the user chose to skip. */
  skipped: Set<string>;
}

/** Profiles list + the snapshot/apply/export/import/delete flows (ROR-62). */
export function useProfiles(onAgentsChanged: () => void) {
  const [profiles, setProfiles] = useState<AgentEnvProfileSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pendingApply, setPendingApply] = useState<PendingProfileApply | null>(null);
  const toasts = useToasts();

  const refresh = useCallback(async () => {
    try {
      setProfiles(await listAgentEnvProfiles());
    } catch {
      // profile listing is non-critical; the panel shows an empty state
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (operation: () => Promise<void>) => {
      if (busy) return;
      setBusy(true);
      try {
        await operation();
      } catch (caught) {
        toasts.error(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(false);
      }
    },
    [busy, toasts],
  );

  const snapshot = useCallback(
    (agent: AgentEnvAgentName, name: string) =>
      run(async () => {
        const profile = await snapshotAgentEnvProfile({ agent, name });
        toasts.success(
          `Snapshotted ${agent} into "${profile.name}" (${Object.keys(profile.mcps).length} MCPs, ${profile.skills.length} skills)`,
        );
        await refresh();
      }),
    [refresh, run, toasts],
  );

  const startApply = useCallback(
    (name: string, agent: AgentEnvAgentName) =>
      run(async () => {
        const preview = await previewAgentEnvProfileApply(name, agent);
        // Conflicts default to skip so a plain "Apply" never silently overwrites.
        const skipped = new Set(
          preview.items
            .filter((item) => item.status === "conflict")
            .map((item) => `${item.category}:${item.name}`),
        );
        setPendingApply({ preview, skipped });
      }),
    [run],
  );

  const toggleSkip = useCallback((key: string) => {
    setPendingApply((current) => {
      if (!current) return current;
      const skipped = new Set(current.skipped);
      if (skipped.has(key)) skipped.delete(key);
      else skipped.add(key);
      return { ...current, skipped };
    });
  }, []);

  const confirmApply = useCallback(
    () =>
      run(async () => {
        if (!pendingApply) return;
        const { preview, skipped } = pendingApply;
        const result = await applyAgentEnvProfile({
          name: preview.profile,
          agent: preview.agent,
          skip: {
            mcps: preview.items
              .filter((item) => item.category === "mcp" && skipped.has(`mcp:${item.name}`))
              .map((item) => item.name),
            skills: preview.items
              .filter((item) => item.category === "skill" && skipped.has(`skill:${item.name}`))
              .map((item) => item.name),
          },
        });
        setPendingApply(null);
        toasts.success(
          `Applied "${result.profile}" to ${result.agent}: ${result.mcpsApplied.length} MCPs, ${result.skillsApplied.length} skills — ${result.backups.length} backup${result.backups.length === 1 ? "" : "s"} written`,
        );
        onAgentsChanged();
      }),
    [onAgentsChanged, pendingApply, run, toasts],
  );

  const exportOne = useCallback(
    (name: string) =>
      run(async () => {
        const { archivePath } = await exportAgentEnvProfile(name);
        toasts.message({ text: `Exported to ${archivePath} (credentials redacted)`, preserve: true });
      }),
    [run, toasts],
  );

  const importArchive = useCallback(
    (file: File) =>
      run(async () => {
        try {
          const result = await importAgentEnvProfile(file);
          toasts.success(importSummary(result.name, result.missingCredentials.length));
          await refresh();
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : String(caught);
          if (!message.includes("already exists")) throw caught;
          const result = await importAgentEnvProfile(file, { force: true });
          toasts.success(`${importSummary(result.name, result.missingCredentials.length)} (overwrote existing)`);
          await refresh();
        }
      }),
    [refresh, run, toasts],
  );

  const deleteOne = useCallback(
    (name: string) =>
      run(async () => {
        await deleteAgentEnvProfile(name);
        toasts.success(`Deleted profile "${name}"`);
        await refresh();
      }),
    [refresh, run, toasts],
  );

  return {
    profiles,
    loading,
    busy,
    pendingApply,
    refresh,
    snapshot,
    startApply,
    toggleSkip,
    confirmApply,
    cancelApply: () => setPendingApply(null),
    exportOne,
    importArchive,
    deleteOne,
  };
}

function importSummary(name: string, missingCount: number): string {
  return missingCount > 0
    ? `Imported "${name}" — ${missingCount} credential${missingCount === 1 ? "" : "s"} still needed`
    : `Imported "${name}"`;
}
