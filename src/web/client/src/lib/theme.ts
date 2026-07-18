import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

/** Same key ThemeToggle has always used, so existing choices carry over. */
const STORAGE_KEY = "nomoreide-theme-choice";

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Storage unavailable — use the safe product default.
  }
  return "dark";
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}

/**
 * Module-level store so every subscriber (header ThemeToggle, Settings page)
 * sees one source of truth — a change in either place updates both.
 */
let current: Theme = readStoredTheme();
const listeners = new Set<() => void>();

export function getTheme(): Theme {
  return current;
}

export function setTheme(next: Theme) {
  if (next === current) return;
  current = next;
  applyTheme(next);
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Storage unavailable (private mode / quota) — keep in-memory state.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): [Theme, (next: Theme) => void] {
  const theme = useSyncExternalStore(subscribe, getTheme, () => "dark" as Theme);
  return [theme, setTheme];
}
