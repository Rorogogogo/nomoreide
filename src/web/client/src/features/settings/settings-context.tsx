import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  getSettings,
  resetGlobalSettings,
  resetProjectSettings,
  updateGlobalSettings,
  updateProjectSettings,
  type AppSettings,
  type AppSettingsPatch,
  type ProjectPreferences,
  type ProjectPreferencesPatch,
} from "@/lib/api";
import { setLanguage, useLanguage } from "@/lib/language";
import { setTheme, useTheme } from "@/lib/theme";
import {
  applyUiPreferences,
  loadUiPreferences,
  resetUiPreferences,
  saveUiPreferences,
  type UiPreferences,
} from "./ui-preferences";

export type SettingsSaveState = "idle" | "saving" | "saved" | "error";

const FALLBACK_GLOBAL: AppSettings = {
  version: 1,
  terminal: {
    fontSize: 13,
    cursorStyle: "block",
    scrollback: 5_000,
    copyOnSelect: false,
    confirmTerminate: true,
  },
};

const FALLBACK_PROJECT: ProjectPreferences = {
  logs: { showTimestamps: true, wrapLines: true },
  database: { confirmWrites: true, resultLimit: 100 },
};

export interface SettingsContextValue {
  loading: boolean;
  loadError: string | null;
  retry: () => Promise<void>;
  saveState: SettingsSaveState;
  saveError: string | null;
  global: AppSettings;
  confirmedGlobal: AppSettings;
  project: ProjectPreferences;
  confirmedProject: ProjectPreferences;
  ui: UiPreferences;
  updateGlobal: (patch: AppSettingsPatch) => Promise<void>;
  updateProject: (patch: ProjectPreferencesPatch) => Promise<void>;
  updateUi: (patch: Partial<Omit<UiPreferences, "version">>) => void;
  resetGlobal: () => Promise<void>;
  resetProject: () => Promise<void>;
  resetUi: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function patchGlobal(current: AppSettings, patch: AppSettingsPatch): AppSettings {
  return {
    ...current,
    terminal: { ...current.terminal, ...patch.terminal },
  };
}

function patchProject(
  current: ProjectPreferences,
  patch: ProjectPreferencesPatch,
): ProjectPreferences {
  return {
    ...current,
    logs: { ...current.logs, ...patch.logs },
    database: { ...current.database, ...patch.database },
  };
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [global, setGlobal] = useState<AppSettings>(FALLBACK_GLOBAL);
  const [confirmedGlobal, setConfirmedGlobal] = useState<AppSettings>(FALLBACK_GLOBAL);
  const [project, setProject] = useState<ProjectPreferences>(FALLBACK_PROJECT);
  const [confirmedProject, setConfirmedProject] =
    useState<ProjectPreferences>(FALLBACK_PROJECT);
  const [ui, setUi] = useState<UiPreferences>(() => loadUiPreferences());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SettingsSaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [legacyTheme] = useTheme();
  const [legacyLanguage] = useLanguage();

  const mountedRef = useRef(true);
  const loadStartedRef = useRef(false);
  const loadRevisionRef = useRef(0);
  const globalRevisionRef = useRef(0);
  const projectRevisionRef = useRef(0);
  const globalQueueRef = useRef<Promise<void>>(Promise.resolve());
  const projectQueueRef = useRef<Promise<void>>(Promise.resolve());
  const globalRef = useRef(global);
  const projectRef = useRef(project);
  const uiRef = useRef(ui);
  const confirmedGlobalRef = useRef(confirmedGlobal);
  const confirmedProjectRef = useRef(confirmedProject);
  const savedTimerRef = useRef<number | null>(null);
  const compatibilityTimerRef = useRef<number | null>(null);
  const compatibilityReadyRef = useRef(false);
  const appliedThemeRef = useRef<"light" | "dark" | null>(null);
  const appliedLanguageRef = useRef(ui.language);

  const clearSavedTimer = useCallback(() => {
    if (savedTimerRef.current !== null) {
      window.clearTimeout(savedTimerRef.current);
      savedTimerRef.current = null;
    }
  }, []);

  const markSaved = useCallback(() => {
    clearSavedTimer();
    setSaveState("saved");
    savedTimerRef.current = window.setTimeout(() => {
      if (mountedRef.current) setSaveState("idle");
    }, 1_500);
  }, [clearSavedTimer]);

  const retry = useCallback(async () => {
    const revision = ++loadRevisionRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const snapshot = await getSettings();
      if (!mountedRef.current || revision !== loadRevisionRef.current) return;
      globalRef.current = snapshot.global;
      projectRef.current = snapshot.project;
      confirmedGlobalRef.current = snapshot.global;
      confirmedProjectRef.current = snapshot.project;
      setGlobal(snapshot.global);
      setProject(snapshot.project);
      setConfirmedGlobal(snapshot.global);
      setConfirmedProject(snapshot.project);
    } catch (error) {
      if (mountedRef.current && revision === loadRevisionRef.current) {
        setLoadError(errorMessage(error));
      }
    } finally {
      if (mountedRef.current && revision === loadRevisionRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (!loadStartedRef.current) {
      loadStartedRef.current = true;
      void retry();
    }
    compatibilityTimerRef.current = window.setTimeout(() => {
      compatibilityReadyRef.current = true;
    }, 0);
    return () => {
      mountedRef.current = false;
      clearSavedTimer();
      if (compatibilityTimerRef.current !== null) {
        window.clearTimeout(compatibilityTimerRef.current);
        compatibilityTimerRef.current = null;
      }
    };
  }, [clearSavedTimer, retry]);

  const applyUi = useCallback((next: UiPreferences) => {
    uiRef.current = next;
    saveUiPreferences(next);
    applyUiPreferences(next);
    setUi(next);

    const effectiveTheme = next.theme === "system"
      ? window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark"
      : next.theme;
    appliedThemeRef.current = effectiveTheme;
    setTheme(effectiveTheme);
    appliedLanguageRef.current = next.language;
    setLanguage(next.language);
  }, []);

  useEffect(() => {
    applyUiPreferences(ui);
    const effectiveTheme = ui.theme === "system"
      ? window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark"
      : ui.theme;
    appliedThemeRef.current = effectiveTheme;
    setTheme(effectiveTheme);
    appliedLanguageRef.current = ui.language;
    setLanguage(ui.language);
  }, []);

  // Keep the pre-hub header toggle and language hook on the same stored values.
  useEffect(() => {
    if (!compatibilityReadyRef.current) return;
    if (appliedThemeRef.current !== null && legacyTheme !== appliedThemeRef.current) {
      const next = { ...ui, theme: legacyTheme };
      uiRef.current = next;
      saveUiPreferences(next);
      setUi(next);
      appliedThemeRef.current = legacyTheme;
    }
  }, [legacyTheme, ui]);

  useEffect(() => {
    if (!compatibilityReadyRef.current) return;
    if (legacyLanguage !== appliedLanguageRef.current) {
      const next = { ...ui, language: legacyLanguage };
      uiRef.current = next;
      saveUiPreferences(next);
      setUi(next);
      appliedLanguageRef.current = legacyLanguage;
    }
  }, [legacyLanguage, ui]);

  const updateUi = useCallback(
    (patch: Partial<Omit<UiPreferences, "version">>) => {
      applyUi({ ...uiRef.current, ...patch });
    },
    [applyUi],
  );

  const resetUi = useCallback(() => {
    applyUi(resetUiPreferences());
  }, [applyUi]);

  const updateGlobal = useCallback(async (patch: AppSettingsPatch) => {
    const revision = ++globalRevisionRef.current;
    const optimistic = patchGlobal(globalRef.current, patch);
    globalRef.current = optimistic;
    setGlobal(optimistic);
    setSaveError(null);
    setSaveState("saving");

    const operation = globalQueueRef.current.then(() => updateGlobalSettings(patch));
    globalQueueRef.current = operation.then(() => undefined, () => undefined);
    try {
      const confirmed = await operation;
      if (!mountedRef.current) return;
      confirmedGlobalRef.current = confirmed;
      setConfirmedGlobal(confirmed);
      if (revision === globalRevisionRef.current) {
        globalRef.current = confirmed;
        setGlobal(confirmed);
        markSaved();
      }
    } catch (error) {
      if (!mountedRef.current || revision !== globalRevisionRef.current) return;
      globalRef.current = confirmedGlobalRef.current;
      setGlobal(confirmedGlobalRef.current);
      setSaveError(`Could not save global settings: ${errorMessage(error)}`);
      setSaveState("error");
    }
  }, [markSaved]);

  const updateProject = useCallback(async (patch: ProjectPreferencesPatch) => {
    const revision = ++projectRevisionRef.current;
    const optimistic = patchProject(projectRef.current, patch);
    projectRef.current = optimistic;
    setProject(optimistic);
    setSaveError(null);
    setSaveState("saving");

    const operation = projectQueueRef.current.then(() => updateProjectSettings(patch));
    projectQueueRef.current = operation.then(() => undefined, () => undefined);
    try {
      const confirmed = await operation;
      if (!mountedRef.current) return;
      confirmedProjectRef.current = confirmed;
      setConfirmedProject(confirmed);
      if (revision === projectRevisionRef.current) {
        projectRef.current = confirmed;
        setProject(confirmed);
        markSaved();
      }
    } catch (error) {
      if (!mountedRef.current || revision !== projectRevisionRef.current) return;
      projectRef.current = confirmedProjectRef.current;
      setProject(confirmedProjectRef.current);
      setSaveError(`Could not save project settings: ${errorMessage(error)}`);
      setSaveState("error");
    }
  }, [markSaved]);

  const resetGlobal = useCallback(async () => {
    const revision = ++globalRevisionRef.current;
    setSaveError(null);
    setSaveState("saving");
    const operation = globalQueueRef.current.then(resetGlobalSettings);
    globalQueueRef.current = operation.then(() => undefined, () => undefined);
    try {
      const confirmed = await operation;
      if (!mountedRef.current) return;
      confirmedGlobalRef.current = confirmed;
      setConfirmedGlobal(confirmed);
      if (revision === globalRevisionRef.current) {
        globalRef.current = confirmed;
        setGlobal(confirmed);
        markSaved();
      }
    } catch (error) {
      if (mountedRef.current && revision === globalRevisionRef.current) {
        setSaveError(`Could not reset global settings: ${errorMessage(error)}`);
        setSaveState("error");
      }
    }
  }, [markSaved]);

  const resetProject = useCallback(async () => {
    const revision = ++projectRevisionRef.current;
    setSaveError(null);
    setSaveState("saving");
    const operation = projectQueueRef.current.then(resetProjectSettings);
    projectQueueRef.current = operation.then(() => undefined, () => undefined);
    try {
      const confirmed = await operation;
      if (!mountedRef.current) return;
      confirmedProjectRef.current = confirmed;
      setConfirmedProject(confirmed);
      if (revision === projectRevisionRef.current) {
        projectRef.current = confirmed;
        setProject(confirmed);
        markSaved();
      }
    } catch (error) {
      if (mountedRef.current && revision === projectRevisionRef.current) {
        setSaveError(`Could not reset project settings: ${errorMessage(error)}`);
        setSaveState("error");
      }
    }
  }, [markSaved]);

  return (
    <SettingsContext.Provider
      value={{
        loading,
        loadError,
        retry,
        saveState,
        saveError,
        global,
        confirmedGlobal,
        project,
        confirmedProject,
        ui,
        updateGlobal,
        updateProject,
        updateUi,
        resetGlobal,
        resetProject,
        resetUi,
      }}
    >
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (!value) throw new Error("useSettings must be used within SettingsProvider");
  return value;
}
