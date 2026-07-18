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
  const theme = window.localStorage.getItem("nomoreide-theme-choice");
  const language =
    window.localStorage.getItem("nomoreide-language") ??
    window.localStorage.getItem("nomoreide-language-choice");
  const sidebarDocked = window.localStorage.getItem("nomoreide:sidebar-docked");
  const projectScope = window.localStorage.getItem("nomoreide:project-scope");
  return {
    ...(theme === "light" || theme === "dark" || theme === "system" ? { theme } : {}),
    ...(language === "en" || language === "zh" ? { language } : {}),
    ...(sidebarDocked === "true" || sidebarDocked === "false"
      ? { sidebarDocked: sidebarDocked === "true" }
      : {}),
    ...(projectScope === "all" || projectScope === "project" ? { projectScope } : {}),
  };
}

function validate(value: unknown): UiPreferences | null {
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

export function saveUiPreferences(preferences: UiPreferences): void {
  try {
    window.localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Storage can be unavailable; the provider still keeps the in-memory value.
  }
}

export function loadUiPreferences(): UiPreferences {
  let stored: UiPreferences | null = null;
  try {
    const raw = window.localStorage.getItem(UI_PREFERENCES_KEY);
    stored = raw ? validate(JSON.parse(raw)) : null;
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
