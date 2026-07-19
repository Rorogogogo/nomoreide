import { useSyncExternalStore } from "react";

export type Language = "en" | "zh";

/** Matches the ROR-58 i18n branch so stored choices carry over when it lands. */
const STORAGE_KEY = "nomoreide-language-choice";

export interface LanguageOption {
  value: Language;
  /** Name in the language's own script. */
  nativeLabel: string;
  /** Name in English, for the secondary line. */
  englishLabel: string;
  /** Whether the UI is actually translated into this language yet. */
  available: boolean;
}

export const LANGUAGE_OPTIONS: LanguageOption[] = [
  { value: "en", nativeLabel: "English", englishLabel: "English", available: true },
  { value: "zh", nativeLabel: "简体中文", englishLabel: "Chinese (Simplified)", available: true },
];

function readStoredLanguage(): Language {
  if (typeof window === "undefined") return "en";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "zh") return stored;
  } catch {
    // Storage unavailable — use English in memory.
  }
  return "en";
}

let current: Language = readStoredLanguage();
if (typeof document !== "undefined") document.documentElement.lang = current;
const listeners = new Set<() => void>();

export function getLanguage(): Language {
  return current;
}

export function setLanguage(next: Language) {
  if (next === current) return;
  current = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Storage unavailable — keep in-memory state.
  }
  document.documentElement.lang = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLanguage(): [Language, (next: Language) => void] {
  const language = useSyncExternalStore(subscribe, getLanguage, () => "en" as Language);
  return [language, setLanguage];
}
