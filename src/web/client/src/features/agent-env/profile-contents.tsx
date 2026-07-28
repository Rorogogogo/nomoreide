import { useEffect, useState } from "react";
import { Globe, Sparkles, TerminalSquare, X } from "lucide-react";
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
 * only; agents' live configs are never touched. Additions come from
 * re-snapshotting, so there is deliberately no "add item" form here.
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

  useEffect(() => {
    let cancelled = false;
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
  }, [name]);

  const patch = async (
    input: Partial<Pick<AgentEnvProfile, "description" | "mcps" | "skills">>,
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

  if (!profile) {
    return (
      <p className="px-3 pb-2 pl-9 text-[11px] text-muted-foreground">
        {error ?? t("agentEnv.loadingProfile")}
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

  const saveDescription = () => {
    const trimmed = description.trim();
    if (trimmed === (profile.description ?? "")) return;
    void patch({ description: trimmed });
  };

  return (
    <div className="space-y-3 border-t border-border/40 px-3 py-3 pl-9">
      <input
        aria-label={t("agentEnv.profileDescAria")}
        className="h-7 w-full rounded-md border border-transparent bg-transparent px-1.5 text-[11px] text-muted-foreground placeholder:text-muted-foreground/60 hover:border-border focus:border-border focus:bg-background focus:text-foreground focus:outline-none"
        disabled={busy}
        onBlur={saveDescription}
        onChange={(event) => setDescription(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        placeholder={t("agentEnv.profileDescPlaceholder")}
        value={description}
      />

      <ItemSection
        busy={busy}
        items={mcps.map(([key, entry]) => ({
          key,
          name: key,
          detail: mcpDetail(entry),
          icon: entry.kind === "remote" ? <Globe /> : <TerminalSquare />,
        }))}
        label={t("agentEnv.mcpServers")}
        onRemove={removeMcp}
      />
      <ItemSection
        busy={busy}
        items={profile.skills.map((skill) => ({
          key: skill.name,
          name: skill.name,
          icon: <Sparkles />,
        }))}
        label={t("agentEnv.skills")}
        onRemove={removeSkill}
      />

      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
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
  onRemove: (key: string) => void;
}) {
  const t = useT();
  return (
    <section>
      <h5 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </h5>
      {items.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{t("agentEnv.none")}</p>
      ) : (
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
                className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/item:opacity-100"
                disabled={busy}
                onClick={() => onRemove(item.key)}
                title={t("agentEnv.removeFromProfile")}
                type="button"
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function mcpDetail(entry: AgentEnvProfileMcp): string {
  return entry.kind === "local"
    ? [entry.command, ...(entry.args ?? [])].join(" ").trim() || "(no command)"
    : `${entry.transport} · ${entry.url}`;
}
