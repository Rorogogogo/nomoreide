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
  mergeUiPreferences,
  parseUiPreferences,
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
  updateUi: (patch: Partial<Omit<UiPreferences, "version">>) => boolean;
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
  const pendingSavesRef = useRef(0);
  const saveCycleErrorRef = useRef<string | null>(null);
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

  const beginSave = useCallback(() => {
    clearSavedTimer();
    if (pendingSavesRef.current === 0) {
      saveCycleErrorRef.current = null;
      setSaveError(null);
    }
    pendingSavesRef.current += 1;
    setSaveState("saving");
  }, [clearSavedTimer]);

  const finishSave = useCallback(
    (failure?: string) => {
      if (failure && !saveCycleErrorRef.current) {
        saveCycleErrorRef.current = failure;
      }
      pendingSavesRef.current = Math.max(0, pendingSavesRef.current - 1);
      if (pendingSavesRef.current > 0) {
        setSaveState("saving");
        if (saveCycleErrorRef.current) setSaveError(saveCycleErrorRef.current);
        return;
      }
      if (saveCycleErrorRef.current) {
        setSaveError(saveCycleErrorRef.current);
        setSaveState("error");
        return;
      }
      markSaved();
    },
    [markSaved],
  );

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

  const applyUi = useCallback((next: UiPreferences): boolean => {
    const validated = parseUiPreferences(next);
    if (!validated) return false;
    saveUiPreferences(validated);
    uiRef.current = validated;
    applyUiPreferences(validated);
    setUi(validated);

    const effectiveTheme = validated.theme === "system"
      ? window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark"
      : validated.theme;
    appliedThemeRef.current = effectiveTheme;
    setTheme(effectiveTheme);
    appliedLanguageRef.current = validated.language;
    setLanguage(validated.language);
    return true;
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
      const next = mergeUiPreferences(uiRef.current, patch);
      return next ? applyUi(next) : false;
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
    beginSave();

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
      }
      finishSave();
    } catch (error) {
      if (!mountedRef.current) return;
      if (revision === globalRevisionRef.current) {
        globalRef.current = confirmedGlobalRef.current;
        setGlobal(confirmedGlobalRef.current);
      }
      finishSave(`Could not save global settings: ${errorMessage(error)}`);
    }
  }, [beginSave, finishSave]);

  const updateProject = useCallback(async (patch: ProjectPreferencesPatch) => {
    const revision = ++projectRevisionRef.current;
    const optimistic = patchProject(projectRef.current, patch);
    projectRef.current = optimistic;
    setProject(optimistic);
    beginSave();

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
      }
      finishSave();
    } catch (error) {
      if (!mountedRef.current) return;
      if (revision === projectRevisionRef.current) {
        projectRef.current = confirmedProjectRef.current;
        setProject(confirmedProjectRef.current);
      }
      finishSave(`Could not save project settings: ${errorMessage(error)}`);
    }
  }, [beginSave, finishSave]);

  const resetGlobal = useCallback(async () => {
    const revision = ++globalRevisionRef.current;
    beginSave();
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
      }
      finishSave();
    } catch (error) {
      if (!mountedRef.current) return;
      finishSave(`Could not reset global settings: ${errorMessage(error)}`);
    }
  }, [beginSave, finishSave]);

  const resetProject = useCallback(async () => {
    const revision = ++projectRevisionRef.current;
    beginSave();
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
      }
      finishSave();
    } catch (error) {
      if (!mountedRef.current) return;
      finishSave(`Could not reset project settings: ${errorMessage(error)}`);
    }
  }, [beginSave, finishSave]);

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
