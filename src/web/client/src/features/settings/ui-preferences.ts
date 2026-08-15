import type { Language } from "@/lib/language";
import {
  applyAccent,
  DEFAULT_ACCENT,
  isValidAccent,
  type AccentChoice,
} from "@/lib/accent";

export const UI_PREFERENCES_KEY = "nomoreide:ui-preferences";

export interface UiPreferences {
  version: 2;
  theme: "light" | "dark" | "system";
  language: Language;
  density: "comfortable" | "compact";
  codeFontSize: number;
  reducedMotion: boolean;
  sidebarDocked: boolean;
  /**
   * Whether the Extensions nav row shows its second layer.
   *
   * Defaults open, and defaults open for existing installs too: the plugins
   * *are* the destinations now that Deploy is not a row of its own, so a
   * collapsed default would hide every provider behind a disclosure triangle.
   */
  extensionsExpanded: boolean;
  agentDockPlacement: "bottom" | "right";
  projectScope: "all" | "project";
  /** Play a short local chime when an agent task exits. */
  agentCompletionSound: boolean;
  /** Global accent choice (preset id or `custom:<hue>`). */
  accent: AccentChoice;
  /** Per-project accent overrides, keyed by repository path. */
  projectAccents: Record<string, AccentChoice>;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function defaultUiPreferences(): UiPreferences {
  return {
    version: 2,
    theme: "system",
    language: "en",
    density: "comfortable",
    codeFontSize: 12,
    reducedMotion: prefersReducedMotion(),
    sidebarDocked: false,
    extensionsExpanded: true,
    agentDockPlacement: "bottom",
    projectScope: "all",
    agentCompletionSound: false,
    accent: DEFAULT_ACCENT,
    projectAccents: {},
  };
}

/** Keep only well-formed `path -> accent` entries; drop anything invalid. */
function sanitizeProjectAccents(value: unknown): Record<string, AccentChoice> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, AccentChoice> = {};
  for (const [path, accent] of Object.entries(value as Record<string, unknown>)) {
    if (path && isValidAccent(accent)) out[path] = accent;
  }
  return out;
}

function readLegacyPreferences(): Partial<UiPreferences> {
  if (typeof window === "undefined") return {};
  const theme = safeGetItem("nomoreide-theme-choice");
  const language =
    safeGetItem("nomoreide-language") ?? safeGetItem("nomoreide-language-choice");
  const sidebarDocked = safeGetItem("nomoreide:sidebar-docked");
  const projectScope = safeGetItem("nomoreide:project-scope");
  return {
    ...(theme === "light" || theme === "dark" || theme === "system" ? { theme } : {}),
    ...(language === "en" || language === "zh" ? { language } : {}),
    ...(sidebarDocked === "true" || sidebarDocked === "false"
      ? { sidebarDocked: sidebarDocked === "true" }
      : {}),
    ...(projectScope === "all" || projectScope === "project" ? { projectScope } : {}),
  };
}

function safeGetItem(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function parseUiPreferences(value: unknown): UiPreferences | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  // Accept v1 (pre-accent) and v2; v1 is migrated by defaulting the new fields.
  if (
    (input.version !== 1 && input.version !== 2) ||
    !["light", "dark", "system"].includes(String(input.theme)) ||
    !["en", "zh"].includes(String(input.language)) ||
    !["comfortable", "compact"].includes(String(input.density)) ||
    typeof input.codeFontSize !== "number" ||
    !Number.isInteger(input.codeFontSize) ||
    input.codeFontSize < 10 ||
    input.codeFontSize > 18 ||
    typeof input.reducedMotion !== "boolean" ||
    typeof input.sidebarDocked !== "boolean" ||
    !["all", "project"].includes(String(input.projectScope))
  ) {
    return null;
  }
  return {
    ...(input as unknown as UiPreferences),
    version: 2,
    agentDockPlacement:
      input.agentDockPlacement === "right" ? "right" : "bottom",
    agentCompletionSound: input.agentCompletionSound === true,
    // Absent in preferences stored before the second-layer nav existed, and
    // `undefined` there must read as open rather than as collapsed.
    extensionsExpanded: input.extensionsExpanded !== false,
    accent: isValidAccent(input.accent) ? input.accent : DEFAULT_ACCENT,
    projectAccents: sanitizeProjectAccents(input.projectAccents),
  };
}

export function mergeUiPreferences(
  current: UiPreferences,
  patch: Partial<Omit<UiPreferences, "version">>,
): UiPreferences | null {
  return parseUiPreferences({ ...current, ...patch });
}

export function saveUiPreferences(preferences: unknown): boolean {
  const validated = parseUiPreferences(preferences);
  if (!validated) return false;
  try {
    window.localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify(validated));
    return true;
  } catch {
    // Storage can be unavailable; the provider still keeps the in-memory value.
    return false;
  }
}

export function loadUiPreferences(): UiPreferences {
  let stored: UiPreferences | null = null;
  try {
    const raw = safeGetItem(UI_PREFERENCES_KEY);
    stored = raw ? parseUiPreferences(JSON.parse(raw)) : null;
  } catch {
    stored = null;
  }
  const preferences = stored ?? { ...defaultUiPreferences(), ...readLegacyPreferences() };
  saveUiPreferences(preferences);
  return preferences;
}

export function resetUiPreferences(): UiPreferences {
  const preferences = defaultUiPreferences();
  saveUiPreferences(preferences);
  return preferences;
}

export function applyUiPreferences(preferences: UiPreferences): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.density = preferences.density;
  root.dataset.reducedMotion = String(preferences.reducedMotion);
  root.style.setProperty("--code-font-size", `${preferences.codeFontSize}px`);
  // Baseline (global) accent so there's no flash before the settings context
  // refines it with any per-project override.
  applyAccent(preferences.accent);
}
