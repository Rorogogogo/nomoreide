import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { McpAuthState } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT, type Translate } from "@/lib/i18n";
import type { CapabilityItem } from "./agent-capability-data";

export type CapabilityKey = "skills" | "mcps" | "plugins" | "hooks";

/** Connection state for one MCP server, as a coloured dot with a tooltip. */
export function itemStateDot(t: Translate, state: McpAuthState | undefined): ReactNode {
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

/** Plugin rows arrive flat, with a plugin's skills/commands marked `sub`. */
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

/**
 * The rows of one capability. Shared by the single-capability dropdown behind
 * the composer chips and the combined panel behind the dock bar's one trigger,
 * so both render an item identically — insertable rows push their invocation
 * into the composer, the rest are plain.
 */
export function CapabilityItemList({
  capability,
  items,
  mcpAuth,
  onClose,
  onInsert,
}: {
  capability: CapabilityKey;
  items: CapabilityItem[];
  mcpAuth?: Record<string, McpAuthState>;
  onClose: () => void;
  onInsert?: (text: string) => void;
}) {
  const t = useT();
  const [expandedPlugins, setExpandedPlugins] = useState<Set<string>>(() => new Set());

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
          <span className={cn("truncate font-mono text-xs", item.sub && "pl-2")}>{item.name}</span>
          {item.childKind ? (
            <span className="ml-auto shrink-0 rounded-sm border border-border px-1 py-0.5 text-[8px] font-medium uppercase leading-none tracking-wide text-muted-foreground">
              {t(item.childKind === "skill" ? "dock.capabilitySkill" : "dock.capabilityCommand")}
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

  if (items.length === 0) {
    return (
      <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
        {t("dock.capabilityEmpty")}
      </div>
    );
  }

  if (capability !== "plugins") {
    return <>{items.map((item, index) => renderItem(item, index))}</>;
  }

  return (
    <>
      {groupPluginItems(items).map((group) => {
        const expanded = expandedPlugins.has(group.parent.name);
        return (
          <div key={group.parent.name}>
            <div className="flex items-center">
              {group.children.length > 0 ? (
                <button
                  aria-expanded={expanded}
                  aria-label={t(
                    expanded ? "dock.pluginChildrenCollapse" : "dock.pluginChildrenExpand",
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
              <div className="min-w-0 flex-1">{renderItem(group.parent, group.parent.name)}</div>
            </div>
            {expanded && group.children.length > 0 ? (
              <div className="ml-3 border-l border-border/60 pl-1">
                {group.children.map((item) => renderItem(item, item.name))}
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}
