import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Plug,
  Puzzle,
  Search,
  Sparkles,
  Webhook,
} from "lucide-react";
import {
  searchSkills,
  type McpAuthState,
  type OneTimeSkillSelection,
  type RemoteSkillResult,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT, type Translate } from "@/lib/i18n";
import { useAgentDock } from "../chat/agent-context";
import type { AgentDockPage } from "./agent-terminal-dock";
import type {
  AgentCapabilities,
  CapabilityItem,
  McpAuthSummary,
} from "./agent-capability-data";

type CapabilityKey = "skills" | "mcps" | "plugins" | "hooks";

const MANAGE_PAGE: Record<CapabilityKey, AgentDockPage> = {
  skills: "agent-env",
  mcps: "agent-env",
  plugins: "agent-env",
  hooks: "agent",
};

function mcpAuthTitle(t: Translate, auth: McpAuthSummary | null): string | undefined {
  if (!auth) return t("dock.mcpAuthChecking");
  if (auth.needsAuth || auth.failed) {
    return [
      auth.needsAuth ? t("dock.mcpNeedsAuth", { count: auth.needsAuth }) : "",
      auth.failed ? t("dock.mcpFailed", { count: auth.failed }) : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }
  return auth.checked ? t("dock.mcpConnected") : undefined;
}

function McpAuthDot({ auth, mcps }: { auth: McpAuthSummary | null; mcps: number }) {
  if (mcps === 0) return null;
  if (!auth) return <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground/50" />;
  if (auth.failed) return <span className="size-1.5 rounded-full bg-red-500" />;
  if (auth.needsAuth) return <span className="size-1.5 rounded-full bg-amber-500" />;
  if (auth.checked) return <span className="size-1.5 rounded-full bg-emerald-500" />;
  return null;
}

function itemStateDot(t: Translate, state: McpAuthState | undefined): ReactNode {
  if (!state) return null;
  const color =
    state === "failed"
      ? "bg-red-500"
      : state === "needs-auth"
        ? "bg-amber-500"
        : state === "unknown"
          ? "bg-muted-foreground/50"
          : "bg-emerald-500";
  const title =
    state === "failed"
      ? t("agent.mcp.failed")
      : state === "needs-auth"
        ? t("agent.mcp.needsAuth")
        : state === "unknown"
          ? t("dock.mcpUnknown")
          : state === "no-auth"
            ? t("dock.mcpNoAuth")
            : t("agent.mcp.connected");
  return (
    <span
      aria-label={title}
      className={cn("size-1.5 shrink-0 rounded-full", color)}
      role="img"
      title={title}
    />
  );
}

interface DropdownAnchor {
  left: number;
  top: number;
  bottom: number;
  up: boolean;
}

function groupPluginItems(items: CapabilityItem[]) {
  const groups: Array<{
    children: CapabilityItem[];
    parent: CapabilityItem;
  }> = [];
  for (const item of items) {
    if (!item.sub || groups.length === 0) {
      groups.push({ children: [], parent: item });
    } else {
      groups.at(-1)?.children.push(item);
    }
  }
  return groups;
}

function anchorFor(target: HTMLElement): DropdownAnchor {
  const rect = target.getBoundingClientRect();
  return {
    left: Math.max(8, Math.min(rect.left, window.innerWidth - 296)),
    top: rect.top,
    bottom: rect.bottom,
    // Open upward when the trigger sits in the lower half (composer strip).
    up: window.innerHeight - rect.bottom < 300,
  };
}

function formatInstalls(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(count);
}

function SkillSearch({
  children,
  onClose,
  onSelect,
}: {
  children: ReactNode;
  onClose: () => void;
  onSelect: (skill: OneTimeSkillSelection) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RemoteSkillResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequenceRef = useRef(0);
  const searching = query.trim().length > 0;

  useEffect(() => {
    const trimmed = query.trim();
    const sequence = ++sequenceRef.current;
    if (trimmed.length < 2) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    const timeout = window.setTimeout(() => {
      void searchSkills(trimmed)
        .then((skills) => {
          if (sequenceRef.current === sequence) setResults(skills);
        })
        .catch((reason) => {
          if (sequenceRef.current !== sequence) return;
          setResults([]);
          setError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => {
          if (sequenceRef.current === sequence) setLoading(false);
        });
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [query]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border p-1.5">
        <label className="flex h-7 items-center gap-1.5 rounded-sm border border-border bg-background px-2 text-muted-foreground focus-within:border-foreground/40">
          <Search className="size-3" aria-hidden />
          <input
            aria-label={t("dock.skillSearchAria")}
            className="min-w-0 flex-1 bg-transparent text-[11px] text-foreground outline-none placeholder:text-muted-foreground"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("dock.skillSearchPlaceholder")}
            value={query}
          />
        </label>
      </div>
      <div aria-live="polite" className="min-h-0 flex-1 overflow-y-auto p-1">
        {!searching ? children : null}
        {searching && loading ? (
          <p className="px-2 py-1 text-[10px] text-muted-foreground">
            {t("dock.skillSearchLoading")}
          </p>
        ) : null}
        {searching && !loading && error ? (
          <p className="px-2 py-1 text-[10px] text-red-500" title={error}>
            {t("dock.skillSearchError")}
          </p>
        ) : null}
        {searching && !loading && !error && query.trim().length >= 2 && results.length === 0 ? (
          <p className="px-2 py-1 text-[10px] text-muted-foreground">
            {t("dock.skillSearchEmpty")}
          </p>
        ) : null}
        {searching && !loading && !error
          ? results.map((skill) => (
              <div
                className="flex items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-muted"
                key={skill.id}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-[11px] text-foreground">{skill.name}</p>
                  <p className="truncate text-[9px] text-muted-foreground">
                    {skill.source} · {formatInstalls(skill.installs)}
                  </p>
                </div>
                <a
                  aria-label={t("dock.skillOpenSource", { name: skill.name })}
                  className="text-muted-foreground hover:text-foreground"
                  href={skill.url}
                  rel="noreferrer"
                  target="_blank"
                >
                  <ExternalLink className="size-3" aria-hidden />
                </a>
                <button
                  className="shrink-0 rounded-sm border border-border px-1.5 py-1 text-[9px] font-medium uppercase tracking-wide text-muted-foreground hover:bg-background hover:text-foreground"
                  onClick={() => {
                    onSelect({ name: skill.name, source: skill.useSource });
                    onClose();
                  }}
                  type="button"
                >
                  {t("dock.skillUseOnce")}
                </button>
              </div>
            ))
          : null}
      </div>
    </div>
  );
}

/**
 * The dropdown a chip/badge opens: every item of that capability, portalled to
 * <body> so the dock's overflow never clips it. Insertable rows push their
 * invocation text into the composer; the footer keeps the old jump to the
 * page where the capability is managed.
 */
function CapabilityDropdown({
  anchor,
  capability,
  count,
  items,
  mcpAuth,
  onClose,
  onInsert,
  onManage,
  onSelectOneTimeSkill,
}: {
  anchor: DropdownAnchor;
  capability: CapabilityKey;
  count: number;
  items: CapabilityItem[];
  mcpAuth?: Record<string, McpAuthState>;
  onClose: () => void;
  onInsert?: (text: string) => void;
  onManage?: () => void;
  onSelectOneTimeSkill?: (skill: OneTimeSkillSelection) => void;
}) {
  const t = useT();
  const menuRef = useRef<HTMLDivElement>(null);
  const [expandedPlugins, setExpandedPlugins] = useState<Set<string>>(
    () => new Set(),
  );
  const heading = {
    skills: { icon: <Sparkles />, label: t("agentEnv.skills") },
    mcps: { icon: <Plug />, label: t("agentEnv.mcpServers") },
    plugins: { icon: <Puzzle />, label: t("agentEnv.plugins") },
    hooks: { icon: <Webhook />, label: t("dock.hooks") },
  }[capability];

  useEffect(() => {
    function onPointerDown(event: globalThis.MouseEvent) {
      const target = event.target as Element;
      if (menuRef.current?.contains(target) || target.closest?.("[data-capability-trigger]")) return;
      onClose();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    // Capture-phase so ancestor scrolls close it too — but not the list's own.
    function onScroll(event: Event) {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  const renderItem = (item: CapabilityItem, keySuffix: number | string) => {
    const insert = item.insert;
    const row =
      capability === "hooks" ? (
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-xs">{item.name}</span>
          {item.detail ? (
            <span
              className="mt-0.5 block truncate font-mono text-[10px] leading-4 text-muted-foreground"
              title={item.detail}
            >
              {item.detail}
            </span>
          ) : null}
        </span>
      ) : (
        <>
          {mcpAuth ? itemStateDot(t, mcpAuth[item.name]) : null}
          <span className={cn("truncate font-mono text-xs", item.sub && "pl-2")}>
            {item.name}
          </span>
          {item.childKind ? (
            <span className="ml-auto shrink-0 rounded-sm border border-border px-1 py-0.5 text-[8px] font-medium uppercase leading-none tracking-wide text-muted-foreground">
              {t(
                item.childKind === "skill"
                  ? "dock.capabilitySkill"
                  : "dock.capabilityCommand",
              )}
            </span>
          ) : null}
          {item.detail ? (
            <span className="ml-auto max-w-[45%] shrink-0 truncate rounded-sm border border-border px-1 py-0.5 text-[10px] uppercase leading-none tracking-wide text-muted-foreground">
              {item.detail}
            </span>
          ) : null}
        </>
      );
    const key = `${item.name}-${keySuffix}`;
    const className = cn(
      "flex w-full gap-2 rounded-sm px-2 py-1.5 text-left transition-colors",
      capability === "hooks" ? "items-start" : "items-center",
      insert && onInsert && "hover:bg-muted",
    );
    return insert && onInsert ? (
      <button
        className={className}
        data-capability-hook-row={capability === "hooks" ? "" : undefined}
        key={key}
        onClick={() => {
          onInsert(insert);
          onClose();
        }}
        type="button"
      >
        {row}
      </button>
    ) : (
      <div
        className={className}
        data-capability-hook-row={capability === "hooks" ? "" : undefined}
        key={key}
      >
        {row}
      </div>
    );
  };

  const itemList =
    items.length === 0 ? (
      <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
        {t("dock.capabilityEmpty")}
      </div>
    ) : capability === "plugins" ? (
      groupPluginItems(items).map((group) => {
        const expanded = expandedPlugins.has(group.parent.name);
        return (
          <div key={group.parent.name}>
            <div className="flex items-center">
              {group.children.length > 0 ? (
                <button
                  aria-expanded={expanded}
                  aria-label={t(
                    expanded
                      ? "dock.pluginChildrenCollapse"
                      : "dock.pluginChildrenExpand",
                    { name: group.parent.name },
                  )}
                  className="grid size-6 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() =>
                    setExpandedPlugins((current) => {
                      const next = new Set(current);
                      if (expanded) next.delete(group.parent.name);
                      else next.add(group.parent.name);
                      return next;
                    })
                  }
                  type="button"
                >
                  {expanded ? (
                    <ChevronDown aria-hidden="true" className="size-3" />
                  ) : (
                    <ChevronRight aria-hidden="true" className="size-3" />
                  )}
                </button>
              ) : (
                <span className="size-6 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                {renderItem(group.parent, group.parent.name)}
              </div>
            </div>
            {expanded && group.children.length > 0 ? (
              <div className="ml-3 border-l border-border/60 pl-1">
                {group.children.map((item) =>
                  renderItem(item, item.name),
                )}
              </div>
            ) : null}
          </div>
        );
      })
    ) : (
      items.map((item, index) => renderItem(item, index))
    );
  const availableHeight = Math.max(
    160,
    anchor.up ? anchor.top - 8 : window.innerHeight - anchor.bottom - 8,
  );

  return createPortal(
    <div
      className="fixed z-50 flex w-72 flex-col overflow-hidden rounded-md border border-border bg-card shadow-md"
      data-capability-menu
      ref={menuRef}
      style={
        anchor.up
          ? {
              left: anchor.left,
              bottom: window.innerHeight - anchor.top + 4,
              maxHeight: availableHeight,
            }
          : {
              left: anchor.left,
              top: anchor.bottom + 4,
              maxHeight: availableHeight,
            }
      }
    >
      <div className="flex h-8 items-center gap-1.5 border-b border-border px-2.5 text-[11px] font-medium text-foreground [&_svg]:size-3.5">
        {heading.icon}
        <span>{heading.label}</span>
        <span className="font-mono text-[10px] font-normal text-muted-foreground">{count}</span>
      </div>
      {capability === "skills" && onSelectOneTimeSkill ? (
        <SkillSearch onClose={onClose} onSelect={onSelectOneTimeSkill}>
          {itemList}
        </SkillSearch>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-1">{itemList}</div>
      )}
      {onManage ? (
        <button
          className="flex w-full items-center border-t border-border px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={() => {
            onManage();
            onClose();
          }}
          type="button"
        >
          {t("dock.capabilityManage")}
        </button>
      ) : null}
    </div>,
    document.body,
  );
}

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
        capability={open.key}
        count={capabilities.counts?.[open.key] ?? 0}
        items={capabilities.items[open.key]}
        mcpAuth={open.key === "mcps" ? capabilities.mcpAuth : undefined}
        onClose={() => setOpen(null)}
        onInsert={onInsert}
        onManage={onNavigate ? () => onNavigate(MANAGE_PAGE[open.key]) : undefined}
        onSelectOneTimeSkill={onSelectOneTimeSkill ?? selectOneTimeSkill}
      />
    ) : null;
  return { openKey: open?.key ?? null, toggle, dropdown };
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
 * Icon-only variant for the dock's header bar: logo + number, full label in
 * the hover tooltip, same dropdowns as the composer chips.
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
  const { openKey, toggle, dropdown } = useCapabilityDropdown(
    capabilities,
    onInsert,
    onNavigate,
    onSelectOneTimeSkill,
  );
  if (!counts) return null;

  const badge = (
    key: CapabilityKey,
    label: string,
    count: number,
    title: string,
    trailing?: ReactNode,
  ) => (
    <button
      aria-expanded={openKey === key}
      className="flex h-7 shrink-0 items-center gap-1 rounded-sm px-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      data-capability-trigger
      onClick={toggle(key)}
      title={title}
      type="button"
    >
      <span>{label}</span>
      <span className="font-mono tabular-nums">{count}</span>
      {trailing}
    </button>
  );

  const mcpTitle = [`${t("agentEnv.mcpServers")}: ${counts.mcps}`, mcpAuthTitle(t, auth)]
    .filter(Boolean)
    .join(" · ");

  return (
    <nav
      aria-label={t("dock.capabilitiesAria", { name: providerLabel ?? "Agent" })}
      className="hidden min-w-0 items-center gap-0.5 overflow-x-auto border-l border-border px-1 [scrollbar-width:none] sm:flex [&::-webkit-scrollbar]:hidden"
    >
      {badge(
        "skills",
        t("dock.capabilitySkillsShort"),
        counts.skills,
        `${t("agentEnv.skills")}: ${counts.skills}`,
      )}
      {badge(
        "mcps",
        t("dock.capabilityMcpShort"),
        counts.mcps,
        mcpTitle,
        <McpAuthDot auth={auth} mcps={counts.mcps} />,
      )}
      {badge(
        "plugins",
        t("dock.capabilityPluginsShort"),
        counts.plugins,
        `${t("agentEnv.plugins")}: ${counts.plugins}`,
      )}
      {badge(
        "hooks",
        t("dock.capabilityHooksShort"),
        counts.hooks,
        `${t("dock.hooks")}: ${counts.hooks}`,
      )}
      {dropdown}
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
