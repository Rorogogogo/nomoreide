import { useMemo, useRef, useState } from "react";
import {
  Archive,
  Camera,
  ChevronRight,
  RefreshCw,
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
import { ProfilePublicationDetails } from "./profile-publication-details";
import { RegistryProfilesPanel } from "./registry-profiles-panel";
import { useRegistryProfiles } from "./use-registry-profiles";
import { useT } from "@/lib/i18n";

const ALL_AGENTS: AgentEnvAgentName[] = ["claude", "codex", "antigravity"];
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Saved profiles (ROR-62): snapshot an agent's setup, apply a profile to an
 * agent (conflict preview handled by the parent dialog), export/import
 * credential-redacted tarballs, delete.
 */
export function ProfilesPanel({
  profiles,
  loading,
  loadError,
  busy,
  onSnapshot,
  onRefresh,
  onRetry,
  onApply,
  onExport,
  onImport,
  onDelete,
  onPublish,
  onChanged,
  registryBusy,
  registryFrontendUrl,
  onInstallRegistry,
}: {
  profiles: AgentEnvProfileSummary[];
  loading: boolean;
  loadError: string | null;
  busy: boolean;
  onSnapshot: (agent: AgentEnvAgentName, name: string) => void;
  onRefresh: (name: string, agent: AgentEnvAgentName) => void;
  onRetry: () => void;
  onApply: (name: string, agent: AgentEnvAgentName) => void;
  onExport: (name: string) => void;
  onImport: (file: File) => void;
  onDelete: (name: string) => void;
  onPublish: (name: string) => void;
  onChanged: () => void;
  registryBusy: boolean;
  registryFrontendUrl?: string;
  onInstallRegistry: (slug: string) => Promise<boolean>;
}) {
  const t = useT();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [snapshotAgent, setSnapshotAgent] =
    useState<AgentEnvAgentName>("claude");
  const [snapshotName, setSnapshotName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmRefresh, setConfirmRefresh] = useState<{
    name: string;
    agent: AgentEnvAgentName;
  } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [publicationExpanded, setPublicationExpanded] = useState<string | null>(null);
  const publicationCatalog = useRegistryProfiles(true);
  const registryVersions = useMemo(
    () => new Map(publicationCatalog.profiles.map((profile) => [profile.slug, profile.version])),
    [publicationCatalog.profiles],
  );
  const trimmedSnapshotName = snapshotName.trim();
  const snapshotNameValid =
    trimmedSnapshotName.length === 0 || PROFILE_NAME_PATTERN.test(trimmedSnapshotName);

  const submitSnapshot = () => {
    if (!trimmedSnapshotName || !snapshotNameValid) return;
    onSnapshot(snapshotAgent, trimmedSnapshotName);
    setSnapshotName("");
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div className="grid min-h-0 flex-1 grid-cols-1 divide-y divide-border md:grid-cols-2 md:divide-x md:divide-y-0">
        <section
          aria-labelledby="agent-profiles-local-title"
          className="flex min-h-0 min-w-0 flex-col"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-card/75 px-3 py-2">
            <span
              className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium"
              id="agent-profiles-local-title"
            >
              <Archive aria-hidden="true" className="size-3.5 text-muted-foreground" />
              {t("agentEnv.profileSourceLocal")}
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {profiles.length}
              </span>
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <div
                aria-label={t("agentEnv.snapshotAgentAria")}
                className="flex h-7 items-center gap-1"
                role="radiogroup"
              >
                {ALL_AGENTS.map((agent) => (
                  <label
                    className={cn(
                      "flex h-full w-7 cursor-pointer items-center justify-center rounded transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                      snapshotAgent === agent
                        ? "bg-foreground text-background"
                        : "opacity-40 hover:opacity-100",
                    )}
                    key={agent}
                    title={t("agentEnv.snapshotAgentTitle", { name: AGENT_LABELS[agent] })}
                  >
                    <input
                      checked={snapshotAgent === agent}
                      className="sr-only"
                      name="agent-env-snapshot-agent"
                      onChange={() => setSnapshotAgent(agent)}
                      type="radio"
                      value={agent}
                    />
                    <AgentLogo agent={agent} className="size-4" />
                  </label>
                ))}
              </div>
              <input
                aria-describedby={!snapshotNameValid ? "agent-env-profile-name-error" : undefined}
                aria-invalid={!snapshotNameValid}
                aria-label={t("agentEnv.newProfileAria")}
                className="h-7 w-36 rounded border border-border bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) => setSnapshotName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submitSnapshot();
                }}
                placeholder={t("agentEnv.profileNamePlaceholder")}
                value={snapshotName}
              />
              <Button
                disabled={busy || trimmedSnapshotName.length === 0 || !snapshotNameValid}
                onClick={submitSnapshot}
                size="sm"
                variant="outline"
              >
                <Camera />
                {t("agentEnv.snapshot")}
              </Button>
              {!snapshotNameValid ? (
                <span
                  className="basis-full text-right text-[10px] text-destructive"
                  id="agent-env-profile-name-error"
                >
                  {t("agentEnv.invalidProfileName")}
                </span>
              ) : null}
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
          ) : loadError && profiles.length === 0 ? (
            <div className="flex items-center justify-between gap-3 px-3 py-3">
              <div className="min-w-0">
                <p className="text-xs font-medium text-destructive">
                  {t("agentEnv.loadProfilesFailed")}
                </p>
                <p className="truncate text-[11px] text-muted-foreground" title={loadError}>
                  {loadError}
                </p>
              </div>
              <Button onClick={onRetry} size="sm" variant="outline">
                <RefreshCw aria-hidden="true" />
                {t("agentEnv.retry")}
              </Button>
            </div>
          ) : profiles.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              {t("agentEnv.noProfiles")}
            </p>
          ) : (
            <ul className="min-h-0 flex-1 divide-y divide-border/60 overflow-y-auto">
              {profiles.map((profile) => (
            <li className="group transition-colors hover:bg-muted/20" key={profile.name}>
              <div className="flex items-center gap-2.5 px-3 py-2">
                <button
                  aria-expanded={expanded === profile.name}
                  className="flex min-w-0 flex-1 items-center gap-2.5 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                      <Badge size="small" variant="outline">
                        {t((profile.pluginCount ?? 0) === 1 ? "agentEnv.pluginCountOne" : "agentEnv.pluginCountMany", { count: profile.pluginCount ?? 0 })}
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
                <button
                  aria-expanded={
                    profile.registry ? publicationExpanded === profile.name : undefined
                  }
                  className="shrink-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    if (!profile.registry) {
                      onPublish(profile.name);
                      return;
                    }
                    setPublicationExpanded(
                      publicationExpanded === profile.name ? null : profile.name,
                    );
                  }}
                  title={
                    profile.registry
                      ? t("agentEnv.publicationViewDetails")
                      : t("agentEnv.publicationNotPublishedTitle")
                  }
                  type="button"
                >
                  <ProfilePublicationBadge
                    hasLocalChanges={profile.registry?.hasLocalChanges ?? false}
                    origin={profile.registry?.origin}
                    registryChanged={
                      Boolean(profile.registry && registryVersions.get(profile.registry.slug)) &&
                      registryVersions.get(profile.registry?.slug ?? "") !== profile.registry?.version
                    }
                    version={profile.registry?.version}
                  />
                </button>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {formatRelativeTime(profile.updatedAt)}
                </span>
                <OverflowMenu
                  className="opacity-100"
                  items={[
                    ...ALL_AGENTS.map((agent) => ({
                      label: t("agentEnv.updateFrom", { name: AGENT_LABELS[agent] }),
                      icon: <RefreshCw className="size-3.5" />,
                      onSelect: () => setConfirmRefresh({ name: profile.name, agent }),
                    })),
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
              {profile.registry && publicationExpanded === profile.name ? (
                <ProfilePublicationDetails
                  busy={registryBusy}
                  link={profile.registry}
                  name={profile.name}
                  onInstall={onInstallRegistry}
                  onPublish={onPublish}
                  registryFrontendUrl={registryFrontendUrl}
                  registryVersion={registryVersions.get(profile.registry.slug)}
                />
              ) : null}
            </li>
              ))}
            </ul>
          )}
        </section>

        <RegistryProfilesPanel
          busy={registryBusy}
          catalog={publicationCatalog}
          onInstall={onInstallRegistry}
        />
      </div>

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
      {confirmRefresh ? (
        <ConfirmDialog
          confirmLabel={t("agentEnv.updateProfile")}
          icon={<RefreshCw />}
          loading={busy}
          message={t("agentEnv.updateProfileBody", {
            name: confirmRefresh.name,
            agent: AGENT_LABELS[confirmRefresh.agent],
          })}
          onCancel={() => setConfirmRefresh(null)}
          onConfirm={() => {
            onRefresh(confirmRefresh.name, confirmRefresh.agent);
            setConfirmRefresh(null);
          }}
          title={t("agentEnv.updateProfileTitle")}
        />
      ) : null}
    </div>
  );
}

function ProfilePublicationBadge({
  hasLocalChanges,
  origin,
  registryChanged,
  version,
}: {
  hasLocalChanges: boolean;
  origin?: "published" | "installed";
  registryChanged: boolean;
  version?: string;
}) {
  const t = useT();
  if (!origin || !version) {
    return (
      <Badge appearance="subtle" size="small" variant="secondary">
        {t("agentEnv.publicationNotPublished")}
      </Badge>
    );
  }
  if (hasLocalChanges && registryChanged) {
    return <Badge size="small" variant="warning">{t("agentEnv.publicationDiverged")}</Badge>;
  }
  if (hasLocalChanges) {
    return <Badge size="small" variant="warning">{t("agentEnv.publicationLocalChanges")}</Badge>;
  }
  if (registryChanged) {
    return (
      <Badge appearance="subtle" size="small" variant="primary">
        {t("agentEnv.publicationRegistryUpdate")}
      </Badge>
    );
  }
  return (
    <Badge size="small" variant="success">
      {t(origin === "published" ? "agentEnv.publicationPublished" : "agentEnv.publicationInstalled")} · v{version}
    </Badge>
  );
}
