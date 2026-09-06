import { useState, type MouseEvent, type ReactNode } from "react";
import {
  Plug,
  Puzzle,
  Sparkles,
  Webhook,
} from "lucide-react";
import type {
  OneTimeSkillSelection,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT, } from "@/lib/i18n";
import { useAgentDock } from "../chat/agent-context";
import type { AgentDockPage } from "./agent-terminal-dock";
import type { CapabilityKey } from "./agent-capability-items";
import type { AgentCapabilities, } from "./agent-capability-data";
import { McpAuthDot, mcpAuthTitle } from "./capability-mcp-auth";
import {
  anchorFor,
  MANAGE_PAGE,
  totalCapabilities,
  type DropdownAnchor,
} from "./capability-anchor";
import {
  CapabilityAllPanel,
  CapabilityDropdown,
} from "./capability-panels";


/** Shared open/toggle state + dropdown element for the strip and the badges. */
function useCapabilityDropdown(
  capabilities: AgentCapabilities,
  onInsert?: (text: string) => void,
  onNavigate?: (page: AgentDockPage) => void,
  onSelectOneTimeSkill?: (skill: OneTimeSkillSelection) => void,
) {
  const { selectOneTimeSkill } = useAgentDock();
  const [open, setOpen] = useState<{ key: CapabilityKey; anchor: DropdownAnchor } | null>(null);
  const toggle = (key: CapabilityKey) => (event: MouseEvent<HTMLButtonElement>) => {
    const anchor = anchorFor(event.currentTarget);
    setOpen((current) => (current?.key === key ? null : { key, anchor }));
  };
  const dropdown =
    open && capabilities.items ? (
      <CapabilityDropdown
        anchor={open.anchor}
        capabilities={capabilities}
        capability={open.key}
        count={capabilities.counts?.[open.key] ?? 0}
        onClose={() => setOpen(null)}
        onInsert={onInsert}
        onManage={onNavigate ? () => onNavigate(MANAGE_PAGE[open.key]) : undefined}
        onSelectOneTimeSkill={onSelectOneTimeSkill ?? selectOneTimeSkill}
      />
    ) : null;
  return { openKey: open?.key ?? null, toggle, dropdown };
}

/** Open/anchor state for the bar's single trigger and its combined panel. */
function useCapabilityPanel(
  capabilities: AgentCapabilities,
  onInsert?: (text: string) => void,
  onNavigate?: (page: AgentDockPage) => void,
  onSelectOneTimeSkill?: (skill: OneTimeSkillSelection) => void,
) {
  const { selectOneTimeSkill } = useAgentDock();
  const [anchor, setAnchor] = useState<DropdownAnchor | null>(null);
  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    const next = anchorFor(event.currentTarget);
    setAnchor((current) => (current ? null : next));
  };
  const panel =
    anchor && capabilities.items ? (
      <CapabilityAllPanel
        anchor={anchor}
        capabilities={capabilities}
        onClose={() => setAnchor(null)}
        onInsert={onInsert}
        onNavigate={onNavigate}
        onSelectOneTimeSkill={onSelectOneTimeSkill ?? selectOneTimeSkill}
      />
    ) : null;
  return { open: !!anchor, toggle, panel };
}

/**
 * Labelled capability chips shown under the dock composer. Each chip opens a
 * dropdown of that capability's items; clicking an item inserts its
 * invocation into the prompt.
 */
export function AgentCapabilityStrip({
  capabilities,
  providerLabel,
  onInsert,
  onNavigate,
  onSelectOneTimeSkill,
}: {
  capabilities: AgentCapabilities;
  providerLabel?: string;
  onInsert?: (text: string) => void;
  onNavigate?: (page: AgentDockPage) => void;
  onSelectOneTimeSkill?: (skill: OneTimeSkillSelection) => void;
}) {
  const t = useT();
  const { counts, auth } = capabilities;
  const { openKey, toggle, dropdown } = useCapabilityDropdown(
    capabilities,
    onInsert,
    onNavigate,
    onSelectOneTimeSkill,
  );
  if (!counts) return null;

  return (
    <nav
      aria-label={t("dock.capabilitiesAria", { name: providerLabel ?? "Agent" })}
      className="mt-2 flex flex-wrap items-center gap-1.5"
    >
      <CapabilityChip
        count={counts.skills}
        expanded={openKey === "skills"}
        icon={<Sparkles />}
        label={t("agentEnv.skills")}
        onClick={toggle("skills")}
      />
      <CapabilityChip
        count={counts.mcps}
        expanded={openKey === "mcps"}
        icon={<Plug />}
        label={t("agentEnv.mcpServers")}
        onClick={toggle("mcps")}
        title={mcpAuthTitle(t, auth)}
        trailing={<McpAuthDot auth={auth} mcps={counts.mcps} />}
      />
      <CapabilityChip
        count={counts.plugins}
        expanded={openKey === "plugins"}
        icon={<Puzzle />}
        label={t("agentEnv.plugins")}
        onClick={toggle("plugins")}
      />
      <CapabilityChip
        count={counts.hooks}
        expanded={openKey === "hooks"}
        icon={<Webhook />}
        label={t("dock.hooks")}
        onClick={toggle("hooks")}
      />
      {dropdown}
    </nav>
  );
}

/**
 * The dock bar's capability affordance: one trigger with the total count, not
 * four counters. The tab row is narrow — and rendered twice in a split — so
 * four permanent chips there squeezed the tab names down to an ellipsis. The
 * MCP auth dot rides on this trigger so a server that needs a login is still
 * visible without opening anything.
 */
export function AgentCapabilityBadges({
  capabilities,
  providerLabel,
  onInsert,
  onNavigate,
  onSelectOneTimeSkill,
}: {
  capabilities: AgentCapabilities;
  providerLabel?: string;
  onInsert?: (text: string) => void;
  onNavigate?: (page: AgentDockPage) => void;
  onSelectOneTimeSkill?: (skill: OneTimeSkillSelection) => void;
}) {
  const t = useT();
  const { counts, auth } = capabilities;
  const { open, toggle, panel } = useCapabilityPanel(
    capabilities,
    onInsert,
    onNavigate,
    onSelectOneTimeSkill,
  );
  if (!counts) return null;

  const title = [
    `${t("agentEnv.skills")}: ${counts.skills}`,
    `${t("agentEnv.mcpServers")}: ${counts.mcps}`,
    `${t("agentEnv.plugins")}: ${counts.plugins}`,
    `${t("dock.hooks")}: ${counts.hooks}`,
    mcpAuthTitle(t, auth),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <nav
      aria-label={t("dock.capabilitiesAria", { name: providerLabel ?? "Agent" })}
      className="hidden min-w-0 items-center border-l border-border px-1 sm:flex"
    >
      <button
        aria-expanded={open}
        className={cn(
          "flex h-7 shrink-0 items-center gap-1 rounded-sm px-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
          open && "bg-muted text-foreground",
        )}
        data-capability-trigger
        onClick={toggle}
        title={title}
        type="button"
      >
        {/* Text, not an icon: the bar deliberately spells its affordances out,
            and the per-capability counts live in the panel's section headings. */}
        <span>{t("dock.capabilitiesTitle")}</span>
        <span className="font-mono tabular-nums">{totalCapabilities(capabilities)}</span>
        <McpAuthDot auth={auth} mcps={counts.mcps} />
      </button>
      {panel}
    </nav>
  );
}

function CapabilityChip({
  count,
  expanded,
  icon,
  label,
  onClick,
  title,
  trailing,
}: {
  count: number;
  expanded: boolean;
  icon: ReactNode;
  label: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  title?: string;
  trailing?: ReactNode;
}) {
  return (
    <button
      aria-expanded={expanded}
      className={cn(
        "flex items-center gap-1.5 rounded-sm border border-border bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-3.5",
        expanded && "bg-muted text-foreground",
      )}
      data-capability-trigger
      onClick={onClick}
      title={title}
      type="button"
    >
      {icon}
      <span>{label}</span>
      <span className="font-mono text-foreground">{count}</span>
      {trailing}
    </button>
  );
}
