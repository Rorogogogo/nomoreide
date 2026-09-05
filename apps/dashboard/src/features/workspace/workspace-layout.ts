import { useCallback, useEffect, useState } from "react";
import { APP_NAV_ITEMS, type AppPage } from "@/components/app-navigation";

export interface WorkspaceTab { page: AppPage; extensionId: string | null }
export interface WorkspacePane { id: "primary" | "secondary"; tabs: WorkspaceTab[]; active: number }
export interface WorkspaceLayout { panes: WorkspacePane[]; focused: number; ratio: number }
const pages = new Set<string>([...APP_NAV_ITEMS.map((item) => item.page), "settings"]);
export const tabId = (tab: WorkspaceTab) => JSON.stringify([tab.page, tab.extensionId]);
export const singlePane = (tab: WorkspaceTab): WorkspaceLayout => ({ panes: [{ id: "primary", tabs: [tab], active: 0 }], focused: 0, ratio: 50 });
export const clampRatio = (ratio: number) => Math.max(25, Math.min(75, ratio));

export function parseLayout(value: string | null): WorkspaceLayout | null {
  try {
    const layout = JSON.parse(value ?? "null") as WorkspaceLayout | null;
    if (!layout || !Array.isArray(layout.panes) || layout.panes.length < 1 || layout.panes.length > 2 || !Number.isInteger(layout.focused) || !layout.panes[layout.focused] || !Number.isFinite(layout.ratio)) return null;
    const ids = new Set<string>();
    if (new Set(layout.panes.map((pane) => pane.id)).size !== layout.panes.length) return null;
    for (const pane of layout.panes) {
      if (pane.id !== "primary" && pane.id !== "secondary") return null;
      if (!Array.isArray(pane.tabs) || !pane.tabs.length || pane.tabs.length > 40 || !Number.isInteger(pane.active) || !pane.tabs[pane.active]) return null;
      for (const tab of pane.tabs) {
        if (!tab || !pages.has(tab.page) || !(tab.extensionId === null || (tab.page === "extensions" && typeof tab.extensionId === "string" && tab.extensionId.length > 0))) return null;
        const id = tabId(tab);
        if (ids.has(id)) return null;
        ids.add(id);
      }
    }
    return { ...layout, ratio: clampRatio(layout.ratio) };
  } catch { return null; }
}

export function openTab(layout: WorkspaceLayout, tab: WorkspaceTab, target = layout.focused): WorkspaceLayout {
  for (const [index, pane] of layout.panes.entries()) {
    const active = pane.tabs.findIndex((entry) => tabId(entry) === tabId(tab));
    if (active >= 0) return { ...layout, focused: index, panes: layout.panes.map((entry, i) => i === index ? { ...entry, active } : entry) };
  }
  const panes = [...layout.panes];
  const pane = panes[target];
  panes[target] = pane ? { ...pane, tabs: [...pane.tabs, tab], active: pane.tabs.length } : { id: panes[0].id === "primary" ? "secondary" : "primary", tabs: [tab], active: 0 };
  return { ...layout, panes, focused: target };
}

export function closeTab(layout: WorkspaceLayout, paneIndex: number, index: number): WorkspaceLayout {
  const pane = layout.panes[paneIndex];
  if (layout.panes.length === 1 && pane.tabs.length === 1) return layout;
  const tabs = pane.tabs.filter((_, i) => i !== index);
  if (!tabs.length) return { ...layout, panes: layout.panes.filter((_, i) => i !== paneIndex), focused: 0 };
  const active = Math.max(0, pane.active - (index <= pane.active ? 1 : 0));
  return { ...layout, panes: layout.panes.map((entry, i) => i === paneIndex ? { ...entry, tabs, active } : entry) };
}

export function mergePanes(layout: WorkspaceLayout): WorkspaceLayout {
  const current = layout.panes[layout.focused].tabs[layout.panes[layout.focused].active];
  const tabs = layout.panes.flatMap((pane) => pane.tabs);
  return { ...layout, focused: 0, panes: [{ id: layout.panes[0].id, tabs, active: tabs.findIndex((tab) => tabId(tab) === tabId(current)) }] };
}

function restore(key: string | null, fallback: WorkspaceLayout): WorkspaceLayout {
  try { return (key && parseLayout(localStorage.getItem(key))) || fallback; }
  catch { return fallback; }
}

export function useWorkspaceLayout(project: string | null, initial: WorkspaceTab, persist = true) {
  const key = project && persist ? `nomoreide:workspace:v1:${project}` : null;
  const [saved, setSaved] = useState(() => ({ key, layout: restore(key, singlePane(initial)) }));
  let layout = saved.layout;
  if (saved.key !== key) {
    layout = restore(key, saved.layout);
    // Honor an explicit deep link when dashboard data first identifies the workspace.
    if (saved.key === null && initial.page !== "home") layout = openTab(layout, initial);
    setSaved({ key, layout });
  }
  useEffect(() => {
    if (!key) return;
    try { localStorage.setItem(key, JSON.stringify(layout)); } catch { /* Storage may be unavailable. */ }
  }, [key, layout]);
  const update = useCallback((change: (current: WorkspaceLayout) => WorkspaceLayout) => setSaved((current) => ({ ...current, layout: change(current.layout) })), []);
  const navigate = useCallback((page: AppPage, extensionId: string | null = null, pane?: number) => update((current) => openTab(current, { page, extensionId }, pane)), [update]);
  const pane = layout.panes[layout.focused];
  return { layout, update, navigate, current: pane.tabs[pane.active] };
}
