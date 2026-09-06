import { createContext } from "react";

/**
 * The two contexts a panel provides and its contents consume: whether the
 * panel is disclosed, and where a docked stats row should portal to.
 *
 * Their own module so `widget-content.tsx` can read them without importing
 * `widget-grid.tsx`, which re-exports it — that would be a cycle.
 */

export interface WidgetDisclosureValue {
  expanded: boolean;
  onToggle: (animate: boolean) => void;
}

export const WidgetDisclosureContext = createContext<WidgetDisclosureValue | null>(null);

export interface WidgetStatsDockValue {
  docked: boolean;
  target: HTMLSpanElement | null;
}

export const WidgetStatsDockContext = createContext<WidgetStatsDockValue | null>(null);
