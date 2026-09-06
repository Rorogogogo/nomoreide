import type { CapabilityKey } from "./agent-capability-items";
import type { AgentCapabilities } from "./agent-capability-data";
import type { AgentDockPage } from "./agent-terminal-dock";

/**
 * Where a capability dropdown opens, and where "Manage" sends you.
 *
 * Shared by the strip (which measures the trigger) and the panels (which read
 * the anchor and the manage target), so it belongs to neither.
 */

export const MANAGE_PAGE: Record<CapabilityKey, AgentDockPage> = {
  skills: "agent-env",
  mcps: "agent-env",
  plugins: "agent-env",
  hooks: "agent",
};

export interface DropdownAnchor {
  left: number;
  top: number;
  bottom: number;
  up: boolean;
}

export function anchorFor(target: HTMLElement): DropdownAnchor {
  const rect = target.getBoundingClientRect();
  return {
    left: Math.max(8, Math.min(rect.left, window.innerWidth - 296)),
    top: rect.top,
    bottom: rect.bottom,
    // Open upward when the trigger sits in the lower half (composer strip).
    up: window.innerHeight - rect.bottom < 300,
  };
}

export function totalCapabilities({ counts }: AgentCapabilities): number {
  if (!counts) return 0;
  return counts.skills + counts.mcps + counts.plugins + counts.hooks;
}
