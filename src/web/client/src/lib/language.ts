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
  /**
   * Whether the UI is actually translated into this language yet. English is
   * the only fully-translated locale today; others persist the preference so
   * it's ready when the string catalogs land, but the UI stays English.
   */
  available: boolean;
}

export const LANGUAGE_OPTIONS: LanguageOption[] = [
  { value: "en", nativeLabel: "English", englishLabel: "English", available: true },
  { value: "zh", nativeLabel: "简体中文", englishLabel: "Chinese (Simplified)", available: false },
];

function readStoredLanguage(): Language {
  if (typeof window === "undefined") return "en";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "en" || stored === "zh") return stored;
  return "en";
}

let current: Language = readStoredLanguage();
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
