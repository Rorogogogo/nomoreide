import { Stethoscope } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { useRegisterRefresh } from "@/components/refresh-registry";
import { AgentColumn } from "./agent-column";
import { ProfileApplyDialog } from "./profile-apply-dialog";
import { ProfilesPanel } from "./profiles-panel";
import { StagedChangesDrawer } from "./staged-changes-drawer";
import { useAgentEnv } from "./use-agent-env";
import { useProfiles } from "./use-profiles";
import { useStagedChanges } from "./use-staged-changes";

/**
 * Agent Environments: a side-by-side view of each coding agent's live MCP
 * servers and skills (ROR-60), copy/move/remove actions staged behind a
 * preview → "Save & apply" gate (ROR-61), and saved profiles with
 * snapshot/apply/export/import (ROR-62).
 */
export function AgentEnvView() {
  const { agents, configs, doctor, loading, error, refresh } = useAgentEnv();
  useRegisterRefresh(refresh);
  const { staged, preview, applying, stage, unstage, clear, apply } =
    useStagedChanges(refresh);
  const profilesState = useProfiles(refresh);

  const availabilityByAgent = new Map(agents.map((agent) => [agent.agent, agent]));
  const warnings = doctor?.checks.filter((check) => check.status !== "ok") ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4">
      {error ? <Alert variant="muted">{error}</Alert> : null}
      {loading && configs.length === 0 ? (
        <Alert variant="muted">Reading agent configurations...</Alert>
      ) : null}

      {warnings.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card/70 px-3 py-2">
          <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Stethoscope className="size-3.5" />
            Doctor
          </span>
          {warnings.map((check) => (
            <Badge key={check.message} size="small" variant="warning">
              {check.message}
            </Badge>
          ))}
        </div>
      ) : null}

      {!loading && configs.length === 0 && !error ? (
        <Alert variant="muted">
          No agent configurations found. Agent Environments reads Claude Code, Codex CLI,
          and Antigravity configs from your home directory.
        </Alert>
      ) : null}

      <ProfilesPanel
        busy={profilesState.busy}
        loading={profilesState.loading}
        onApply={profilesState.startApply}
        onDelete={profilesState.deleteOne}
        onExport={profilesState.exportOne}
        onImport={profilesState.importArchive}
        onSnapshot={profilesState.snapshot}
        profiles={profilesState.profiles}
      />

      {configs.length > 0 ? (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {configs.map((config) => (
            <AgentColumn
              key={config.agent}
              availability={availabilityByAgent.get(config.agent)}
              config={config}
              onStage={stage}
            />
          ))}
        </div>
      ) : null}

      <StagedChangesDrawer
        applying={applying}
        count={staged.length}
        onApply={() => void apply()}
        onClear={clear}
        onUnstage={unstage}
        preview={preview}
      />

      {profilesState.pendingApply ? (
        <ProfileApplyDialog
          busy={profilesState.busy}
          onCancel={profilesState.cancelApply}
          onConfirm={() => void profilesState.confirmApply()}
          onToggle={profilesState.toggleSkip}
          pending={profilesState.pendingApply}
        />
      ) : null}
    </div>
  );
}
