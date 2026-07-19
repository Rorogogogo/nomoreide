import { useRef, useState } from "react";
import {
  Archive,
  Camera,
  ChevronRight,
  Trash2,
  Upload,
  UploadCloud,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { OverflowMenu } from "@/components/ui/overflow-menu";
import { UnknownAgentLogo } from "@/features/agent/agent-logos";
import type { AgentEnvAgentName, AgentEnvProfileSummary } from "@/lib/api";
import { cn, formatRelativeTime } from "@/lib/utils";
import { AGENT_LABELS, AgentLogo } from "./agent-column";
import { ProfileContents } from "./profile-contents";
import { useT } from "@/lib/i18n";

const ALL_AGENTS: AgentEnvAgentName[] = ["claude", "codex", "antigravity"];

/**
 * Saved profiles (ROR-62): snapshot an agent's setup, apply a profile to an
 * agent (conflict preview handled by the parent dialog), export/import
 * credential-redacted tarballs, delete.
 */
export function ProfilesPanel({
  profiles,
  loading,
  busy,
  onSnapshot,
  onApply,
  onExport,
  onImport,
  onDelete,
  onPublish,
  onChanged,
}: {
  profiles: AgentEnvProfileSummary[];
  loading: boolean;
  busy: boolean;
  onSnapshot: (agent: AgentEnvAgentName, name: string) => void;
  onApply: (name: string, agent: AgentEnvAgentName) => void;
  onExport: (name: string) => void;
  onImport: (file: File) => void;
  onDelete: (name: string) => void;
  onPublish: (name: string) => void;
  onChanged: () => void;
}) {
  const t = useT();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [snapshotAgent, setSnapshotAgent] =
    useState<AgentEnvAgentName>("claude");
  const [snapshotName, setSnapshotName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const submitSnapshot = () => {
    const name = snapshotName.trim();
    if (!name) return;
    onSnapshot(snapshotAgent, name);
    setSnapshotName("");
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold">
          <Archive className="size-3.5 text-muted-foreground" />
          {t("agentEnv.profilesTitle")}
          {profiles.length > 0 ? (
            <Badge size="small" variant="outline">
              {profiles.length}
            </Badge>
          ) : null}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <div
            aria-label={t("agentEnv.snapshotAgentAria")}
            className="flex h-8 items-center gap-0.5 rounded-md border border-border bg-muted/40 p-0.5"
            role="radiogroup"
          >
            {ALL_AGENTS.map((agent) => (
              <button
                aria-checked={snapshotAgent === agent}
                className={cn(
                  "flex h-full w-8 items-center justify-center rounded transition-colors",
                  snapshotAgent === agent
                    ? "bg-background shadow-sm"
                    : "opacity-40 hover:bg-muted/60 hover:opacity-100",
                )}
                key={agent}
                onClick={() => setSnapshotAgent(agent)}
                role="radio"
                title={t("agentEnv.snapshotAgentTitle", { name: AGENT_LABELS[agent] })}
                type="button"
              >
                <AgentLogo agent={agent} className="size-4" />
              </button>
            ))}
          </div>
          <input
            aria-label={t("agentEnv.newProfileAria")}
            className="h-8 w-36 rounded-md border border-border bg-background px-2 text-xs"
            onChange={(event) => setSnapshotName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitSnapshot();
            }}
            placeholder={t("agentEnv.profileNamePlaceholder")}
            value={snapshotName}
          />
          <Button
            disabled={busy || snapshotName.trim().length === 0}
            onClick={submitSnapshot}
            size="sm"
            variant="outline"
          >
            <Camera />
            {t("agentEnv.snapshot")}
          </Button>
          <Button
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
            size="sm"
            variant="outline"
          >
            <Upload />
            {t("agentEnv.import")}
          </Button>
          <input
            accept=".tar.gz,.tgz,application/gzip"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onImport(file);
              event.target.value = "";
            }}
            ref={fileInputRef}
            type="file"
          />
        </div>
      </div>

      {loading ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {t("agentEnv.loadingProfiles")}
        </p>
      ) : profiles.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {t("agentEnv.noProfiles")}
        </p>
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-border/60 overflow-y-auto">
          {profiles.map((profile) => (
            <li className="group" key={profile.name}>
              <div className="flex items-center gap-2.5 px-3 py-2">
                <button
                  aria-expanded={expanded === profile.name}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                  onClick={() =>
                    setExpanded(expanded === profile.name ? null : profile.name)
                  }
                  type="button"
                >
                  <span
                    className="shrink-0"
                    title={
                      profile.sourceAgent
                        ? t("agentEnv.snapshotOf", { name: AGENT_LABELS[profile.sourceAgent] })
                        : t("agentEnv.importedProfile")
                    }
                  >
                    {profile.sourceAgent ? (
                      <AgentLogo
                        agent={profile.sourceAgent}
                        className="size-4"
                      />
                    ) : (
                      <UnknownAgentLogo className="size-4 text-muted-foreground" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-xs font-medium">
                        {profile.name}
                      </span>
                      <Badge size="small" variant="outline">
                        {t(profile.mcpCount === 1 ? "agentEnv.mcpCountOne" : "agentEnv.mcpCountMany", { count: profile.mcpCount })}
                      </Badge>
                      <Badge size="small" variant="outline">
                        {t(profile.skillCount === 1 ? "agentEnv.skillCountOne" : "agentEnv.skillCountMany", { count: profile.skillCount })}
                      </Badge>
                      <ChevronRight
                        className={cn(
                          "size-3.5 shrink-0 text-muted-foreground transition-transform",
                          expanded === profile.name
                            ? "rotate-90"
                            : "opacity-0 group-hover:opacity-100",
                        )}
                      />
                    </span>
                    {profile.description && expanded !== profile.name ? (
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {profile.description}
                      </span>
                    ) : null}
                  </span>
                </button>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {formatRelativeTime(profile.updatedAt)}
                </span>
                <OverflowMenu
                  className="opacity-100"
                  items={[
                    ...ALL_AGENTS.map((agent) => ({
                      label: t("agentEnv.applyTo", { name: AGENT_LABELS[agent] }),
                      onSelect: () => onApply(profile.name, agent),
                    })),
                    {
                      label: t("agentEnv.exportTar"),
                      icon: <Archive className="size-3.5" />,
                      onSelect: () => onExport(profile.name),
                    },
                    {
                      label: t("agentEnv.publishRegistry"),
                      icon: <UploadCloud className="size-3.5" />,
                      onSelect: () => onPublish(profile.name),
                    },
                    {
                      label: t("agentEnv.delete"),
                      icon: <Trash2 className="size-3.5" />,
                      onSelect: () => setConfirmDelete(profile.name),
                    },
                  ]}
                  label={t("agentEnv.profileActions", { name: profile.name })}
                />
              </div>
              {expanded === profile.name ? (
                <ProfileContents name={profile.name} onChanged={onChanged} />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {confirmDelete ? (
        <ConfirmDialog
          confirmLabel={t("agentEnv.delete")}
          icon={<Trash2 />}
          message={t("agentEnv.deleteProfileBody", { name: confirmDelete })}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            onDelete(confirmDelete);
            setConfirmDelete(null);
          }}
          title={t("agentEnv.deleteProfileTitle")}
          tone="danger"
        />
      ) : null}
    </div>
  );
}
