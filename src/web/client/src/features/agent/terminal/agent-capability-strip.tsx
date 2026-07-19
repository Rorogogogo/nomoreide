import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Plug, Puzzle, Sparkles, Webhook } from "lucide-react";
import type { McpAuthState } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT, type Translate } from "@/lib/i18n";
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

function itemStateDot(state: McpAuthState | undefined): ReactNode {
  if (!state) return null;
  const color =
    state === "failed"
      ? "bg-red-500"
      : state === "needs-auth"
        ? "bg-amber-500"
        : state === "unknown"
          ? "bg-muted-foreground/50"
          : "bg-emerald-500";
  return <span className={cn("size-1.5 shrink-0 rounded-full", color)} />;
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

/**
 * The dropdown a chip/badge opens: every item of that capability, portalled to
 * <body> so the dock's overflow never clips it. Insertable rows push their
 * invocation text into the composer; the footer keeps the old jump to the
 * page where the capability is managed.
 */
function CapabilityDropdown({
  anchor,
  items,
  mcpAuth,
  onClose,
  onInsert,
  onManage,
}: {
  anchor: DropdownAnchor;
  items: CapabilityItem[];
  mcpAuth?: Record<string, McpAuthState>;
  onClose: () => void;
  onInsert?: (text: string) => void;
  onManage?: () => void;
}) {
  const t = useT();
  const menuRef = useRef<HTMLDivElement>(null);

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

  return createPortal(
    <div
      className="fixed z-50 w-72 overflow-hidden rounded-md border border-border bg-card shadow-md"
      data-capability-menu
      ref={menuRef}
      style={
        anchor.up
          ? { left: anchor.left, bottom: window.innerHeight - anchor.top + 4 }
          : { left: anchor.left, top: anchor.bottom + 4 }
      }
    >
      <div className="max-h-64 overflow-y-auto p-1">
        {items.length === 0 ? (
          <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
            {t("dock.capabilityEmpty")}
          </div>
        ) : (
          items.map((item, index) => {
            const insert = item.insert;
            const row = (
              <>
                {mcpAuth ? itemStateDot(mcpAuth[item.name]) : null}
                <span className={cn("truncate font-mono text-xs", item.sub && "pl-4")}>
                  {item.name}
                </span>
                {item.detail ? (
                  <span className="ml-auto max-w-[45%] shrink-0 truncate pl-2 text-[10px] text-muted-foreground">
                    {item.detail}
                  </span>
                ) : null}
              </>
            );
            const key = `${item.name}-${index}`;
            return insert && onInsert ? (
              <button
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-muted"
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
              <div className="flex w-full items-center gap-2 px-2 py-1.5" key={key}>
                {row}
              </div>
            );
          })
        )}
      </div>
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
) {
  const [open, setOpen] = useState<{ key: CapabilityKey; anchor: DropdownAnchor } | null>(null);
  const toggle = (key: CapabilityKey) => (event: MouseEvent<HTMLButtonElement>) => {
    const anchor = anchorFor(event.currentTarget);
    setOpen((current) => (current?.key === key ? null : { key, anchor }));
  };
  const dropdown =
    open && capabilities.items ? (
      <CapabilityDropdown
        anchor={open.anchor}
        items={capabilities.items[open.key]}
        mcpAuth={open.key === "mcps" ? capabilities.mcpAuth : undefined}
        onClose={() => setOpen(null)}
        onInsert={onInsert}
        onManage={onNavigate ? () => onNavigate(MANAGE_PAGE[open.key]) : undefined}
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
}: {
  capabilities: AgentCapabilities;
  providerLabel?: string;
  onInsert?: (text: string) => void;
  onNavigate?: (page: AgentDockPage) => void;
}) {
  const t = useT();
  const { counts, auth } = capabilities;
  const { openKey, toggle, dropdown } = useCapabilityDropdown(capabilities, onInsert, onNavigate);
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
}: {
  capabilities: AgentCapabilities;
  providerLabel?: string;
  onInsert?: (text: string) => void;
  onNavigate?: (page: AgentDockPage) => void;
}) {
  const t = useT();
  const { counts, auth } = capabilities;
  const { openKey, toggle, dropdown } = useCapabilityDropdown(capabilities, onInsert, onNavigate);
  if (!counts) return null;

  const badge = (
    key: CapabilityKey,
    icon: ReactNode,
    count: number,
    title: string,
    trailing?: ReactNode,
  ) => (
    <button
      aria-expanded={openKey === key}
      className="flex h-7 items-center gap-1 rounded-sm px-1.5 font-mono text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-3"
      data-capability-trigger
      onClick={toggle(key)}
      title={title}
      type="button"
    >
      {icon}
      <span>{count}</span>
      {trailing}
    </button>
  );

  const mcpTitle = [`${t("agentEnv.mcpServers")}: ${counts.mcps}`, mcpAuthTitle(t, auth)]
    .filter(Boolean)
    .join(" · ");

  return (
    <nav
      aria-label={t("dock.capabilitiesAria", { name: providerLabel ?? "Agent" })}
      className="hidden shrink-0 items-center gap-0.5 border-l border-border px-1 sm:flex"
    >
      {badge("skills", <Sparkles />, counts.skills, `${t("agentEnv.skills")}: ${counts.skills}`)}
      {badge(
        "mcps",
        <Plug />,
        counts.mcps,
        mcpTitle,
        <McpAuthDot auth={auth} mcps={counts.mcps} />,
      )}
      {badge("plugins", <Puzzle />, counts.plugins, `${t("agentEnv.plugins")}: ${counts.plugins}`)}
      {badge("hooks", <Webhook />, counts.hooks, `${t("dock.hooks")}: ${counts.hooks}`)}
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
        "flex items-center gap-1.5 rounded-sm border border-border bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-3",
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
