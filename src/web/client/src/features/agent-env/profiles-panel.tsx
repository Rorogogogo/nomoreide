import { useRef, useState } from "react";
import { Archive, Camera, Trash2, Upload, UploadCloud } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { OverflowMenu } from "@/components/ui/overflow-menu";
import type { AgentEnvAgentName, AgentEnvProfileSummary } from "@/lib/api";
import { AGENT_LABELS } from "./agent-column";

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
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [snapshotAgent, setSnapshotAgent] = useState<AgentEnvAgentName>("claude");
  const [snapshotName, setSnapshotName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const submitSnapshot = () => {
    const name = snapshotName.trim();
    if (!name) return;
    onSnapshot(snapshotAgent, name);
    setSnapshotName("");
  };

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold">
          <Archive className="size-3.5 text-muted-foreground" />
          Profiles
          {profiles.length > 0 ? (
            <Badge size="small" variant="outline">
              {profiles.length}
            </Badge>
          ) : null}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Agent to snapshot"
            className="h-8 rounded-md border border-border bg-background px-2 text-xs"
            onChange={(event) => setSnapshotAgent(event.target.value as AgentEnvAgentName)}
            value={snapshotAgent}
          >
            {ALL_AGENTS.map((agent) => (
              <option key={agent} value={agent}>
                {AGENT_LABELS[agent]}
              </option>
            ))}
          </select>
          <input
            aria-label="New profile name"
            className="h-8 w-36 rounded-md border border-border bg-background px-2 text-xs"
            onChange={(event) => setSnapshotName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitSnapshot();
            }}
            placeholder="profile name"
            value={snapshotName}
          />
          <Button
            disabled={busy || snapshotName.trim().length === 0}
            onClick={submitSnapshot}
            size="sm"
            variant="outline"
          >
            <Camera />
            Snapshot
          </Button>
          <Button
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
            size="sm"
            variant="outline"
          >
            <Upload />
            Import
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
        <p className="px-3 py-2 text-xs text-muted-foreground">Loading profiles...</p>
      ) : profiles.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          No profiles yet. Snapshot an agent to capture its MCPs and skills as a reusable
          bundle, or import a shared .tar.gz.
        </p>
      ) : (
        <ul className="max-h-44 divide-y divide-border/60 overflow-y-auto">
          {profiles.map((profile) => (
            <li className="group flex items-center gap-3 px-3 py-2" key={profile.name}>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-medium">{profile.name}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {profile.mcpCount} MCP{profile.mcpCount === 1 ? "" : "s"} ·{" "}
                    {profile.skillCount} skill{profile.skillCount === 1 ? "" : "s"}
                  </span>
                </span>
                {profile.description ? (
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {profile.description}
                  </span>
                ) : null}
              </span>
              <OverflowMenu
                className="opacity-100"
                items={[
                  ...ALL_AGENTS.map((agent) => ({
                    label: `Apply to ${AGENT_LABELS[agent]}`,
                    onSelect: () => onApply(profile.name, agent),
                  })),
                  {
                    label: "Export .tar.gz",
                    icon: <Archive className="size-3.5" />,
                    onSelect: () => onExport(profile.name),
                  },
                  {
                    label: "Publish to registry...",
                    icon: <UploadCloud className="size-3.5" />,
                    onSelect: () => onPublish(profile.name),
                  },
                  {
                    label: "Delete",
                    icon: <Trash2 className="size-3.5" />,
                    onSelect: () => setConfirmDelete(profile.name),
                  },
                ]}
                label={`Actions for ${profile.name}`}
              />
            </li>
          ))}
        </ul>
      )}

      {confirmDelete ? (
        <ConfirmDialog
          confirmLabel="Delete"
          icon={<Trash2 />}
          message={`Delete profile "${confirmDelete}"? Agents' live configs are not touched.`}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            onDelete(confirmDelete);
            setConfirmDelete(null);
          }}
          title="Delete profile"
          tone="danger"
        />
      ) : null}
    </div>
  );
}
