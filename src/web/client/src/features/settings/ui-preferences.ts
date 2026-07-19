import type { Language } from "@/lib/language";

export const UI_PREFERENCES_KEY = "nomoreide:ui-preferences";

export interface UiPreferences {
  version: 1;
  theme: "light" | "dark" | "system";
  language: Language;
  density: "comfortable" | "compact";
  codeFontSize: number;
  reducedMotion: boolean;
  sidebarDocked: boolean;
  projectScope: "all" | "project";
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function defaultUiPreferences(): UiPreferences {
  return {
    version: 1,
    theme: "system",
    language: "en",
    density: "comfortable",
    codeFontSize: 12,
    reducedMotion: prefersReducedMotion(),
    sidebarDocked: false,
    projectScope: "all",
  };
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
  if (
    input.version !== 1 ||
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
  return input as unknown as UiPreferences;
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
}
