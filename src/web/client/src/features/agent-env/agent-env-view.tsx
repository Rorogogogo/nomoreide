import { useState } from "react";
import { Puzzle, Stethoscope } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useRegisterRefresh } from "@/components/refresh-registry";
import { AgentColumn } from "./agent-column";
import { ProfileApplyDialog } from "./profile-apply-dialog";
import { ProfilePublishDialog } from "./profile-publish-dialog";
import { ProfilesPanel } from "./profiles-panel";
import { RegistryPanel } from "./registry-panel";
import { StagedChangesDrawer } from "./staged-changes-drawer";
import { useAgentEnv } from "./use-agent-env";
import { useProfiles } from "./use-profiles";
import { useRegistry } from "./use-registry";
import { useStagedChanges } from "./use-staged-changes";
import { useT } from "@/lib/i18n";

/**
 * Agent Environments: a side-by-side view of each coding agent's live MCP
 * servers and skills (ROR-60), copy/move/remove actions staged behind a
 * preview → "Save & apply" gate (ROR-61), saved profiles with
 * snapshot/apply/export/import (ROR-62), and the hosted profile registry
 * (ROR-63) for sharing profiles by slug.
 */
export function AgentEnvView() {
  const t = useT();
  const { agents, configs, doctor, loading, error, refresh } = useAgentEnv();
  useRegisterRefresh(refresh);
  const { staged, preview, applying, stage, unstage, clear, apply } =
    useStagedChanges(refresh);
  const profilesState = useProfiles(refresh);
  const registry = useRegistry(profilesState.refresh);
  const [publishing, setPublishing] = useState<string | null>(null);
  const [tab, setTab] = useState<"agents" | "profiles">("agents");

  const availabilityByAgent = new Map(agents.map((agent) => [agent.agent, agent]));
  const warnings = doctor?.checks.filter((check) => check.status !== "ok") ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col bg-card/85">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Puzzle className="size-4 text-muted-foreground" />
        <span className="text-sm font-semibold">{t("agentEnv.title")}</span>
        <div className="ml-2 flex items-center gap-0.5 rounded-md border border-border bg-muted/40 p-0.5">
          {(["agents", "profiles"] as const).map((id) => (
            <button
              className={cn(
                "flex h-6 items-center gap-1.5 rounded px-2.5 text-xs font-medium transition-colors",
                tab === id
                  ? "bg-background shadow-sm"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
              key={id}
              onClick={() => setTab(id)}
              type="button"
            >
              {id === "agents" ? t("agentEnv.tabAgents") : t("agentEnv.tabProfiles")}
              {id === "profiles" && profilesState.profiles.length > 0 ? (
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {profilesState.profiles.length}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        {warnings.length > 0 ? (
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="ml-2 flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <Stethoscope className="size-3.5" />
              {t("agentEnv.doctor")}
            </span>
            {warnings.map((check) => (
              <Badge key={check.message} size="small" variant="warning">
                {check.message}
              </Badge>
            ))}
          </span>
        ) : null}
      </header>

      {error ? (
        <Alert className="m-3 shrink-0" variant="muted">
          {error}
        </Alert>
      ) : null}

      {tab === "profiles" ? (
        <div className="grid min-h-0 flex-1 grid-cols-1 divide-y divide-border lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:divide-x lg:divide-y-0">
          <ProfilesPanel
            busy={profilesState.busy}
            loading={profilesState.loading}
            onApply={profilesState.startApply}
            onChanged={profilesState.refresh}
            onDelete={profilesState.deleteOne}
            onExport={profilesState.exportOne}
            onImport={profilesState.importArchive}
            onPublish={setPublishing}
            onSnapshot={profilesState.snapshot}
            profiles={profilesState.profiles}
          />

          <RegistryPanel
            busy={registry.busy}
            onInstall={registry.install}
            onSignIn={() => void registry.signIn()}
            onSignOut={registry.signOut}
            signingIn={registry.signingIn}
            status={registry.status}
          />
        </div>
      ) : configs.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {configs.map((config) => (
              <AgentColumn
                key={config.agent}
                availability={availabilityByAgent.get(config.agent)}
                config={config}
                onStage={stage}
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-center">
          <p className="max-w-sm text-xs text-muted-foreground">
            {loading ? t("agentEnv.readingConfigs") : error ? null : t("agentEnv.noConfigs")}
          </p>
        </div>
      )}

      <StagedChangesDrawer
        applying={applying}
        count={staged.length}
        onApply={() => void apply()}
        onClear={clear}
        onUnstage={unstage}
        preview={preview}
      />

      {publishing ? (
        <ProfilePublishDialog
          busy={registry.busy}
          onCancel={() => setPublishing(null)}
          onConfirm={(input) => {
            void registry.publish(input).then((published) => {
              if (published) setPublishing(null);
            });
          }}
          profileName={publishing}
        />
      ) : null}

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
