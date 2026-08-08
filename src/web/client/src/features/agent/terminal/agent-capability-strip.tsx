import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Plug,
  Puzzle,
  Search,
  Settings2,
  Sparkles,
  Webhook,
} from "lucide-react";
import {
  searchSkills,
  type OneTimeSkillSelection,
  type RemoteSkillResult,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT, type Translate } from "@/lib/i18n";
import { useAgentDock } from "../chat/agent-context";
import type { AgentDockPage } from "./agent-terminal-dock";
import { CapabilityItemList, type CapabilityKey } from "./agent-capability-items";
import type { AgentCapabilities, McpAuthSummary } from "./agent-capability-data";

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

interface DropdownAnchor {
  left: number;
  top: number;
  bottom: number;
  up: boolean;
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

/** Close on outside click, Escape, or an ancestor scrolling out from under. */
function useDismiss(menuRef: { current: HTMLDivElement | null }, onClose: () => void) {
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
  }, [menuRef, onClose]);
}

const HEADINGS: Record<CapabilityKey, { icon: ReactNode; labelKey: Parameters<Translate>[0] }> = {
  skills: { icon: <Sparkles />, labelKey: "agentEnv.skills" },
  mcps: { icon: <Plug />, labelKey: "agentEnv.mcpServers" },
  plugins: { icon: <Puzzle />, labelKey: "agentEnv.plugins" },
  hooks: { icon: <Webhook />, labelKey: "dock.hooks" },
};

/** The portalled card both panels live in, positioned against its trigger. */
function PanelShell({
  anchor,
  children,
  footer,
  heading,
  menuRef,
}: {
  anchor: DropdownAnchor;
  children: ReactNode;
  footer?: ReactNode;
  heading: ReactNode;
  menuRef: React.RefObject<HTMLDivElement | null>;
}) {
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
        {heading}
      </div>
      {children}
      {footer}
    </div>,
    document.body,
  );
}

/** "Manage in <page>" footer row, shared by both panels. */
function ManageFooter({ onClose, onManage }: { onClose: () => void; onManage?: () => void }) {
  const t = useT();
  if (!onManage) return null;
  return (
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
  );
}

/**
 * The dropdown a composer chip opens: every item of that one capability,
 * portalled to <body> so the dock's overflow never clips it.
 */
function CapabilityDropdown({
  anchor,
  capability,
  count,
  capabilities,
  onClose,
  onInsert,
  onManage,
  onSelectOneTimeSkill,
}: {
  anchor: DropdownAnchor;
  capability: CapabilityKey;
  count: number;
  capabilities: AgentCapabilities;
  onClose: () => void;
  onInsert?: (text: string) => void;
  onManage?: () => void;
  onSelectOneTimeSkill?: (skill: OneTimeSkillSelection) => void;
}) {
  const t = useT();
  const menuRef = useRef<HTMLDivElement>(null);
  useDismiss(menuRef, onClose);
  const heading = HEADINGS[capability];

  const itemList = (
    <CapabilityItemList
      capability={capability}
      items={capabilities.items?.[capability] ?? []}
      mcpAuth={capability === "mcps" ? capabilities.mcpAuth : undefined}
      onClose={onClose}
      onInsert={onInsert}
    />
  );

  return (
    <PanelShell
      anchor={anchor}
      footer={<ManageFooter onClose={onClose} onManage={onManage} />}
      heading={
        <>
          {heading.icon}
          <span>{t(heading.labelKey)}</span>
          <span className="font-mono text-[10px] font-normal text-muted-foreground">{count}</span>
        </>
      }
      menuRef={menuRef}
    >
      {capability === "skills" && onSelectOneTimeSkill ? (
        <SkillSearch onClose={onClose} onSelect={onSelectOneTimeSkill}>
          {itemList}
        </SkillSearch>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-1">{itemList}</div>
      )}
    </PanelShell>
  );
}

const ALL_CAPABILITIES: CapabilityKey[] = ["skills", "mcps", "plugins", "hooks"];

/**
 * Everything the agent can reach, behind the bar's single trigger, as two
 * layers: pick a category, then pick an item. Four categories' worth of items
 * stacked flat made a long scroll where the counts — the thing you actually
 * glance at — were pushed apart by the lists between them.
 */
function CapabilityAllPanel({
  anchor,
  capabilities,
  onClose,
  onInsert,
  onNavigate,
  onSelectOneTimeSkill,
}: {
  anchor: DropdownAnchor;
  capabilities: AgentCapabilities;
  onClose: () => void;
  onInsert?: (text: string) => void;
  onNavigate?: (page: AgentDockPage) => void;
  onSelectOneTimeSkill?: (skill: OneTimeSkillSelection) => void;
}) {
  const t = useT();
  const menuRef = useRef<HTMLDivElement>(null);
  useDismiss(menuRef, onClose);
  const [section, setSection] = useState<CapabilityKey | null>(null);
  const { auth, counts } = capabilities;

  // Layer 2: one category's items, with a way back to the category list.
  if (section) {
    const heading = HEADINGS[section];
    const itemList = (
      <CapabilityItemList
        capability={section}
        items={capabilities.items?.[section] ?? []}
        mcpAuth={section === "mcps" ? capabilities.mcpAuth : undefined}
        onClose={onClose}
        onInsert={onInsert}
      />
    );
    return (
      <PanelShell
        anchor={anchor}
        footer={
          <ManageFooter
            onClose={onClose}
            onManage={onNavigate ? () => onNavigate(MANAGE_PAGE[section]) : undefined}
          />
        }
        heading={
          <>
            <button
              aria-label={t("dock.capabilityBack")}
              className="-ml-1 grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={() => setSection(null)}
              type="button"
            >
              <ChevronLeft />
            </button>
            {heading.icon}
            <span>{t(heading.labelKey)}</span>
            <span className="font-mono text-[10px] font-normal text-muted-foreground">
              {counts?.[section] ?? 0}
            </span>
          </>
        }
        menuRef={menuRef}
      >
        {section === "skills" && onSelectOneTimeSkill ? (
          <SkillSearch onClose={onClose} onSelect={onSelectOneTimeSkill}>
            {itemList}
          </SkillSearch>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-1">{itemList}</div>
        )}
      </PanelShell>
    );
  }

  // Layer 1: the four categories and their counts.
  return (
    <PanelShell
      anchor={anchor}
      footer={
        <ManageFooter
          onClose={onClose}
          onManage={onNavigate ? () => onNavigate("agent-env") : undefined}
        />
      }
      heading={
        <>
          <Settings2 />
          <span>{t("dock.capabilitiesTitle")}</span>
          <span className="font-mono text-[10px] font-normal text-muted-foreground">
            {totalCapabilities(capabilities)}
          </span>
        </>
      }
      menuRef={menuRef}
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {ALL_CAPABILITIES.map((capability) => {
          const heading = HEADINGS[capability];
          const count = counts?.[capability] ?? 0;
          return (
            <button
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[11px] text-foreground transition-colors hover:bg-muted [&_svg]:size-3.5 [&_svg]:shrink-0"
              disabled={count === 0}
              key={capability}
              onClick={() => setSection(capability)}
              type="button"
            >
              <span className="text-muted-foreground">{heading.icon}</span>
              <span className="min-w-0 flex-1 truncate">{t(heading.labelKey)}</span>
              {capability === "mcps" ? <McpAuthDot auth={auth} mcps={count} /> : null}
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                {count}
              </span>
              <ChevronRight className="text-muted-foreground" />
            </button>
          );
        })}
      </div>
    </PanelShell>
  );
}

/** Every capability the agent can reach, as one number for the bar's trigger. */
function totalCapabilities({ counts }: AgentCapabilities): number {
  if (!counts) return 0;
  return counts.skills + counts.mcps + counts.plugins + counts.hooks;
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
