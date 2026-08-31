export const AGENT_DOCK_LAYOUT_KEY = "nomoreide:agent-dock-layout";

const MAX_STORED_DIMENSION = 10_000;
const MAX_STORED_TASK_IDS = 100;

export interface AgentDockLayoutPreferences {
  version: 1;
  open: boolean;
  bottomHeight: number | null;
  rightWidth: number;
  splitPercent: number;
  rightTaskIds: string[];
  activeLeftTaskId: string | null;
  activeRightTaskId: string | null;
  focusedPane: "left" | "right";
  /** Whether the conversation-history sidebar is showing. */
  historyRailOpen: boolean;
}

export type AgentDockLayoutPatch = Partial<
  Omit<AgentDockLayoutPreferences, "version">
>;

export function defaultAgentDockLayoutPreferences(): AgentDockLayoutPreferences {
  return {
    version: 1,
    open: false,
    bottomHeight: null,
    rightWidth: 480,
    splitPercent: 50,
    rightTaskIds: [],
    activeLeftTaskId: null,
    activeRightTaskId: null,
    focusedPane: "left",
    historyRailOpen: false,
  };
}

function storedDimension(value: unknown, fallback: number | null): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_STORED_DIMENSION
    ? Math.round(value)
    : fallback;
}

function taskId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function parseAgentDockLayoutPreferences(
  value: unknown,
): AgentDockLayoutPreferences {
  const fallback = defaultAgentDockLayoutPreferences();
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const input = value as Record<string, unknown>;
  if (input.version !== 1) return fallback;

  const ids = Array.isArray(input.rightTaskIds)
    ? input.rightTaskIds
        .map(taskId)
        .filter((id): id is string => id !== null)
    : [];

  return {
    version: 1,
    open: typeof input.open === "boolean" ? input.open : fallback.open,
    bottomHeight:
      input.bottomHeight === null
        ? null
        : storedDimension(input.bottomHeight, fallback.bottomHeight),
    rightWidth:
      storedDimension(input.rightWidth, fallback.rightWidth) ??
      fallback.rightWidth,
    splitPercent:
      typeof input.splitPercent === "number" &&
      Number.isFinite(input.splitPercent)
        ? Math.max(25, Math.min(75, input.splitPercent))
        : fallback.splitPercent,
    rightTaskIds: [...new Set(ids)].slice(0, MAX_STORED_TASK_IDS),
    activeLeftTaskId: taskId(input.activeLeftTaskId),
    activeRightTaskId: taskId(input.activeRightTaskId),
    focusedPane: input.focusedPane === "right" ? "right" : "left",
    historyRailOpen:
      typeof input.historyRailOpen === "boolean"
        ? input.historyRailOpen
        : fallback.historyRailOpen,
  };
}

export function mergeAgentDockLayoutPreferences(
  current: AgentDockLayoutPreferences,
  patch: AgentDockLayoutPatch,
): AgentDockLayoutPreferences {
  return parseAgentDockLayoutPreferences({ ...current, ...patch, version: 1 });
}

export function loadAgentDockLayoutPreferences(): AgentDockLayoutPreferences {
  try {
    const raw = window.localStorage.getItem(AGENT_DOCK_LAYOUT_KEY);
    return raw
      ? parseAgentDockLayoutPreferences(JSON.parse(raw))
      : defaultAgentDockLayoutPreferences();
  } catch {
    return defaultAgentDockLayoutPreferences();
  }
}

export function saveAgentDockLayoutPreferences(
  preferences: AgentDockLayoutPreferences,
): boolean {
  try {
    const validated = parseAgentDockLayoutPreferences(preferences);
    window.localStorage.setItem(
      AGENT_DOCK_LAYOUT_KEY,
      JSON.stringify(validated),
    );
    return true;
  } catch {
    return false;
  }
}
