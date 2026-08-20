import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Boxes,
  Globe,
  Sparkles,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  getAgentEnvProfile,
  updateAgentEnvProfile,
  type AgentEnvProfile,
  type AgentEnvProfileMcp,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useOperations } from "@/components/operations/operation-context";

/**
 * Expanded profile row: view the bundled MCPs/skills and lightly edit them —
 * per-item remove plus an editable description. Edits PATCH the stored profile
 * only; agents' live configs are never touched. Contents are added or replaced
 * through the parent panel's guarded "Update from agent" flow.
 */
export function ProfileContents({
  name,
  onChanged,
}: {
  name: string;
  onChanged: () => void;
}) {
  const t = useT();
  const { isPending, runOperation } = useOperations();
  const [profile, setProfile] = useState<AgentEnvProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const operationKey = `agent-env:profile:${name}:update`;
  const busy = isPending(operationKey);
  const [description, setDescription] = useState("");
  const [reloadCount, setReloadCount] = useState(0);
  const [pendingRemoval, setPendingRemoval] = useState<{
    category: "mcp" | "skill" | "plugin";
    key: string;
    name: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    getAgentEnvProfile(name)
      .then((loaded) => {
        if (cancelled || !loaded) return;
        setProfile(loaded);
        setDescription(loaded.description ?? "");
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [name, reloadCount]);

  const patch = async (
    input: Partial<Pick<AgentEnvProfile, "description" | "mcps" | "skills" | "plugins">>,
  ) => {
    setError(null);
    try {
      const updated = await runOperation(
        {
          key: operationKey,
          label: t("agentEnv.updatingProfile", { name }),
        },
        () => updateAgentEnvProfile(name, input),
      );
      setProfile(updated);
      setDescription(updated.description ?? "");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!profile && error) {
    return (
      <div className="flex items-center justify-between gap-3 px-3 pb-3 pl-9">
        <p className="min-w-0 truncate text-[11px] text-destructive" title={error}>{error}</p>
        <Button onClick={() => setReloadCount((count) => count + 1)} size="sm" variant="outline">
          {t("agentEnv.retry")}
        </Button>
      </div>
    );
  }

  if (!profile) {
    return (
      <p className="px-3 pb-2 pl-9 text-[11px] text-muted-foreground">
        {t("agentEnv.loadingProfile")}
      </p>
    );
  }

  const mcps = Object.entries(profile.mcps);

  const removeMcp = (key: string) => {
    const { [key]: _removed, ...rest } = profile.mcps;
    void patch({ mcps: rest });
  };

  const removeSkill = (skillName: string) => {
    void patch({
      skills: profile.skills.filter((skill) => skill.name !== skillName),
    });
  };
  const removePlugin = (bundleKey: string) => {
    void patch({
      plugins: (profile.plugins ?? []).filter((plugin) => plugin.bundleKey !== bundleKey),
    });
  };

  const saveDescription = () => {
    const trimmed = description.trim();
    if (trimmed === (profile.description ?? "")) return;
    void patch({ description: trimmed });
  };
  const descriptionDirty = description.trim() !== (profile.description ?? "");

  const confirmRemoval = () => {
    if (!pendingRemoval) return;
    if (pendingRemoval.category === "mcp") removeMcp(pendingRemoval.key);
    else if (pendingRemoval.category === "skill") removeSkill(pendingRemoval.key);
    else removePlugin(pendingRemoval.key);
    setPendingRemoval(null);
  };

  return (
    <div className="space-y-3 border-t border-border/40 px-3 py-3 pl-9">
      <div className="flex items-center gap-2">
        <input
          aria-label={t("agentEnv.profileDescAria")}
          className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-2 text-[11px] placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          disabled={busy}
          onChange={(event) => setDescription(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && descriptionDirty) saveDescription();
            if (event.key === "Escape") setDescription(profile.description ?? "");
          }}
          placeholder={t("agentEnv.profileDescPlaceholder")}
          value={description}
        />
        {descriptionDirty ? (
          <span className="flex shrink-0 items-center gap-1">
            <Button
              disabled={busy}
              onClick={() => setDescription(profile.description ?? "")}
              size="sm"
              variant="ghost"
            >
              {t("agentEnv.cancelEdit")}
            </Button>
            <Button disabled={busy} onClick={saveDescription} size="sm">
              {t("agentEnv.saveDescription")}
            </Button>
          </span>
        ) : null}
      </div>

      <ItemSection
        busy={busy}
        items={mcps.map(([key, entry]) => ({
          key,
          name: key,
          detail: mcpDetail(entry),
          icon: entry.kind === "remote" ? <Globe aria-hidden="true" /> : <TerminalSquare aria-hidden="true" />,
        }))}
        label={t("agentEnv.mcpServers")}
        onRemove={(key, itemName) => setPendingRemoval({ category: "mcp", key, name: itemName })}
      />
      <ItemSection
        busy={busy}
        items={profile.skills.map((skill) => ({
          key: skill.name,
          name: skill.name,
          icon: <Sparkles aria-hidden="true" />,
        }))}
        label={t("agentEnv.skills")}
        onRemove={(key, itemName) => setPendingRemoval({ category: "skill", key, name: itemName })}
      />
      <ItemSection
        busy={busy}
        items={(profile.plugins ?? []).map((plugin) => ({
          key: plugin.bundleKey,
          name: plugin.name,
          detail: [plugin.sourceAgent, plugin.source, plugin.version].filter(Boolean).join(" · "),
          icon: <Boxes aria-hidden="true" />,
        }))}
        label={t("agentEnv.plugins")}
        onRemove={(key, itemName) => setPendingRemoval({ category: "plugin", key, name: itemName })}
      />

      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
      {pendingRemoval ? (
        <ConfirmDialog
          confirmLabel={t("agentEnv.remove")}
          icon={<Trash2 />}
          loading={busy}
          message={t("agentEnv.removeItemBody", { name: pendingRemoval.name })}
          onCancel={() => setPendingRemoval(null)}
          onConfirm={confirmRemoval}
          title={t("agentEnv.removeItemTitle")}
          tone="danger"
        />
      ) : null}
    </div>
  );
}

function ItemSection({
  label,
  items,
  busy,
  onRemove,
}: {
  label: string;
  items: Array<{
    key: string;
    name: string;
    detail?: string;
    icon: React.ReactNode;
  }>;
  busy: boolean;
  onRemove: (key: string, name: string) => void;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(() => items.length <= 5);
  return (
    <section>
      <h5>
        <button
          aria-expanded={expanded}
          className="flex h-6 w-full items-center gap-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          {expanded ? (
            <ChevronDown aria-hidden="true" className="size-3" />
          ) : (
            <ChevronRight aria-hidden="true" className="size-3" />
          )}
          <span>{label}</span>
          <span className="font-mono font-normal tabular-nums">
            {items.length}
          </span>
        </button>
      </h5>
      {expanded && items.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{t("agentEnv.none")}</p>
      ) : expanded ? (
        <ul className="divide-y divide-border/60 border-y border-border/60">
          {items.map((item) => (
            <li
              className="group/item flex items-start gap-2 px-2 py-2 transition-colors hover:bg-muted/20"
              key={item.key}
            >
              <span className="mt-0.5 text-muted-foreground [&_svg]:size-3.5">
                {item.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium">{item.name}</span>
                {item.detail ? (
                  <span
                    className="block truncate font-mono text-[11px] text-muted-foreground"
                    title={item.detail}
                  >
                    {item.detail}
                  </span>
                ) : null}
              </span>
              <button
                aria-label={t("agentEnv.removeItemAria", { name: item.name })}
                className="rounded p-1 text-muted-foreground opacity-60 transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/item:opacity-100"
                disabled={busy}
                onClick={() => onRemove(item.key, item.name)}
                title={t("agentEnv.removeItemAria", { name: item.name })}
                type="button"
              >
                <Trash2 aria-hidden="true" className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function mcpDetail(entry: AgentEnvProfileMcp): string {
  return entry.kind === "local"
    ? [entry.command, ...(entry.args ?? [])].join(" ").trim() || "(no command)"
    : `${entry.transport} · ${entry.url}`;
}
