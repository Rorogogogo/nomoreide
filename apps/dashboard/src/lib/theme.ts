import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = Exclude<Theme, "system">;

/** Same key ThemeToggle has always used, so existing choices carry over. */
const STORAGE_KEY = "nomoreide-theme-choice";
const UI_PREFERENCES_KEY = "nomoreide:ui-preferences";

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "system";
  try {
    const raw = window.localStorage.getItem(UI_PREFERENCES_KEY);
    const stored = raw ? (JSON.parse(raw) as { theme?: unknown; version?: unknown }) : null;
    // Any version, deliberately. This runs before the app mounts to keep the
    // first paint from flashing the wrong theme, and it reads one field that
    // has meant the same thing since v1 — so listing the versions it knows
    // only creates a way for the next schema bump to break the theme, which it
    // has already done once. The parser in `ui-preferences.ts` is what decides
    // whether a stored document is usable; this only needs a string.
    if (
      typeof stored?.version === "number" &&
      (stored.theme === "light" || stored.theme === "dark" || stored.theme === "system")
    ) return stored.theme;
  } catch {
    // Malformed or unavailable canonical storage can still fall back to legacy.
  }
  try {
    const legacy = window.localStorage.getItem(STORAGE_KEY);
    if (legacy === "light" || legacy === "dark" || legacy === "system") return legacy;
  } catch {
    // Storage unavailable — use the safe product default.
  }
  return "system";
}

function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme !== "system") return theme;
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(theme: ResolvedTheme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}

/**
 * Module-level store so every subscriber (header ThemeToggle, Settings page)
 * sees one source of truth — a change in either place updates both.
 */
let current: Theme = readStoredTheme();
let resolved = resolveTheme(current);
const listeners = new Set<() => void>();
let stopSystemListener: (() => void) | null = null;

function notify() {
  for (const listener of listeners) listener();
}

function syncSystemTheme() {
  stopSystemListener?.();
  stopSystemListener = null;
  resolved = resolveTheme(current);
  applyTheme(resolved);
  if (
    current !== "system" ||
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) return;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = (event: MediaQueryListEvent) => {
    resolved = event.matches ? "dark" : "light";
    applyTheme(resolved);
    notify();
  };
  media.addEventListener("change", onChange);
  stopSystemListener = () => media.removeEventListener("change", onChange);
}

syncSystemTheme();

export function getTheme(): Theme {
  return current;
}

export function getResolvedTheme(): ResolvedTheme {
  return resolved;
}

export function setTheme(next: Theme) {
  const changed = next !== current;
  if (!changed) {
    if (next === "system" && !stopSystemListener) syncSystemTheme();
    else {
      resolved = resolveTheme(next);
      applyTheme(resolved);
    }
    return;
  }
  current = next;
  syncSystemTheme();
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Storage unavailable (private mode / quota) — keep in-memory state.
  }
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (current === "system" && !stopSystemListener) syncSystemTheme();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopSystemListener?.();
      stopSystemListener = null;
    }
  };
}

export function useTheme(): [Theme, (next: Theme) => void] {
  const theme = useSyncExternalStore(subscribe, getTheme, () => "system" as Theme);
  return [theme, setTheme];
}

export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, getResolvedTheme, () => "dark");
}
