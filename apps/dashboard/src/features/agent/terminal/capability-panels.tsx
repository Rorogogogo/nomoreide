import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Plug, Puzzle, Settings2, Sparkles, Webhook } from "lucide-react";
import type { OneTimeSkillSelection } from "@/lib/api";
import { useT, type Translate } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { CapabilityItemList, type CapabilityKey } from "./agent-capability-items";
import type { AgentCapabilities, McpAuthSummary } from "./agent-capability-data";
import { McpAuthDot } from "./capability-mcp-auth";
import {
  MANAGE_PAGE,
  totalCapabilities,
  type DropdownAnchor,
} from "./capability-anchor";
import type { AgentDockPage } from "./agent-terminal-dock";
import { SkillSearch } from "./capability-skill-search";

/**
 * The dropdown panels behind the capability strip: one capability's list, and
 * the "all" panel that pages between them.
 *
 * Split from `agent-capability-strip.tsx`, which keeps the badges, the anchor
 * maths and the open/close state. These render a panel and call back.
 */

export function useDismiss(menuRef: { current: HTMLDivElement | null }, onClose: () => void) {
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

export const HEADINGS: Record<CapabilityKey, { icon: ReactNode; labelKey: Parameters<Translate>[0] }> = {
  skills: { icon: <Sparkles />, labelKey: "agentEnv.skills" },
  mcps: { icon: <Plug />, labelKey: "agentEnv.mcpServers" },
  plugins: { icon: <Puzzle />, labelKey: "agentEnv.plugins" },
  hooks: { icon: <Webhook />, labelKey: "dock.hooks" },
};

/** The portalled card both panels live in, positioned against its trigger. */
export function PanelShell({
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
export function ManageFooter({ onClose, onManage }: { onClose: () => void; onManage?: () => void }) {
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
export function CapabilityDropdown({
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

export const ALL_CAPABILITIES: CapabilityKey[] = ["skills", "mcps", "plugins", "hooks"];

/**
 * Everything the agent can reach, behind the bar's single trigger, as two
 * layers: pick a category, then pick an item. Four categories' worth of items
 * stacked flat made a long scroll where the counts — the thing you actually
 * glance at — were pushed apart by the lists between them.
 */
export function CapabilityAllPanel({
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