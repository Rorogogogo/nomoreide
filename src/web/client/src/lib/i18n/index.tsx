import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  getStoredLanguage,
  LANGUAGE_STORAGE_KEY,
  type Language,
} from "@/lib/language";
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

interface I18nContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: Translate;
}

const I18nContext = createContext<I18nContextValue | null>(null);

/**
 * App-wide language state + translator. Holds the active language in one place
 * (persisted to localStorage) so switching it re-renders every consumer. The
 * translator resolves `zh[key] ?? en[key] ?? key`, so a partial locale falls
 * back to English and a missing key surfaces as the key itself (a loud tell in
 * dev rather than a silent blank).
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(() => getStoredLanguage());

  useEffect(() => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    document.documentElement.lang = language;
  }, [language]);

  const setLanguage = useCallback((next: Language) => setLanguageState(next), []);

  const t = useCallback<Translate>(
    (key, params) => interpolate(CATALOGS[language][key] ?? en[key] ?? key, params),
    [language],
  );

  const value = useMemo(
    () => ({ language, setLanguage, t }),
    [language, setLanguage, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within an I18nProvider");
  return ctx;
}

/** The translator function. `const t = useT();` then `t("nav.services")`. */
export function useT(): Translate {
  return useI18n().t;
}

/** Read/set the active language. Mirrors a `useState` tuple for ergonomics. */
export function useLanguage(): [Language, (language: Language) => void] {
  const { language, setLanguage } = useI18n();
  return [language, setLanguage];
}
