import { useMemo } from "react";
import { getLanguage, useLanguage, type Language } from "@/lib/language";
import { en, type TranslationKey } from "./en";
import { zh } from "./zh";

const CATALOGS: Record<Language, Partial<Record<TranslationKey, string>>> = {
  en,
  zh,
};

export type TranslateParams = Record<string, string | number>;
export type Translate = (key: TranslationKey, params?: TranslateParams) => string;

/** Replace `{name}` placeholders in a catalog string with provided values. */
function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

function translateIn(language: Language): Translate {
  return (key, params) => interpolate(CATALOGS[language][key] ?? en[key] ?? key, params);
}

/**
 * The translator function. `const t = useT();` then `t("nav.services")`.
 *
 * Language state lives in the `lib/language` external store (shared with the
 * settings hub), so there is no provider — every `useT` consumer subscribes to
 * the store and re-renders on switch. Resolution is `zh[key] ?? en[key] ?? key`:
 * a partial locale falls back to English and a missing key surfaces as the key
 * itself (a loud tell in dev rather than a silent blank).
 */
export function useT(): Translate {
  const [language] = useLanguage();
  // Memoized per language so `t` is a valid useCallback/useEffect dependency.
  return useMemo(() => translateIn(language), [language]);
}

/** Non-hook translator for code outside React (toast helpers, formatters). */
export function translate(key: TranslationKey, params?: TranslateParams): string {
  return translateIn(getLanguage())(key, params);
}

export { useLanguage };
export type { Language, TranslationKey };
