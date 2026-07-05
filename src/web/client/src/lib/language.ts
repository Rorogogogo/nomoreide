export type Language = "en" | "zh";

export const LANGUAGE_STORAGE_KEY = "nomoreide-language-choice";

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
  { value: "zh", nativeLabel: "简体中文", englishLabel: "Chinese (Simplified)", available: true },
];

export function getStoredLanguage(): Language {
  if (typeof window === "undefined") return "en";
  const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  if (stored === "en" || stored === "zh") return stored;
  return "en";
}
