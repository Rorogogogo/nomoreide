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
import { setTheme, useTheme, type Theme } from "@/lib/theme";
import { applyAccent, effectiveAccent } from "@/lib/accent";
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
    smoothScroll: true,
    externalTerminal: "automatic",
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
  activeProjectPath: string | null;
  projectLoading: boolean;
  projectLoadError: string | null;
  selectProject: (path: string | null) => Promise<void>;
  retryProject: () => Promise<void>;
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
  const [activeProjectPath, setActiveProjectPath] = useState<string | null>(null);
  const [projectLoading, setProjectLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SettingsSaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [legacyTheme] = useTheme();
  const [legacyLanguage] = useLanguage();

  const mountedRef = useRef(true);
  const loadStartedRef = useRef(false);
  const loadRevisionRef = useRef(0);
  const projectLoadRevisionRef = useRef(0);
  const globalRevisionRef = useRef(0);
  const projectRevisionRef = useRef(0);
  const globalQueueRef = useRef<Promise<void>>(Promise.resolve());
  const projectQueueRef = useRef<Promise<void>>(Promise.resolve());
  const globalRef = useRef(global);
  const projectRef = useRef(project);
  const activeProjectPathRef = useRef<string | null>(null);
  const projectLoadPromiseRef = useRef<Promise<void> | null>(null);
  const uiRef = useRef(ui);
  const confirmedGlobalRef = useRef(confirmedGlobal);
  const confirmedProjectRef = useRef(confirmedProject);
  const savedTimerRef = useRef<number | null>(null);
  const pendingSavesRef = useRef(0);
  const saveCycleErrorRef = useRef<string | null>(null);
  const compatibilityTimerRef = useRef<number | null>(null);
  const compatibilityReadyRef = useRef(false);
  const appliedThemeRef = useRef<Theme | null>(null);
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

  const selectProject = useCallback((path: string | null): Promise<void> => {
    if (activeProjectPathRef.current === path) {
      return projectLoadPromiseRef.current ?? Promise.resolve();
    }

    const selectionRevision = ++projectLoadRevisionRef.current;
    ++projectRevisionRef.current;
    activeProjectPathRef.current = path;
    setActiveProjectPath(path);
    setProjectLoadError(null);

    projectRef.current = structuredClone(FALLBACK_PROJECT);
    confirmedProjectRef.current = structuredClone(FALLBACK_PROJECT);
    setProject(projectRef.current);
    setConfirmedProject(confirmedProjectRef.current);

    if (path === null) {
      setProjectLoading(false);
      projectLoadPromiseRef.current = null;
      return Promise.resolve();
    }

    setProjectLoading(true);
    const pendingProject = projectQueueRef.current;
    const operation = pendingProject
      .then(() => getSettings(path))
      .then((snapshot) => {
        if (
          !mountedRef.current ||
          selectionRevision !== projectLoadRevisionRef.current ||
          activeProjectPathRef.current !== path
        ) return;
        projectRef.current = snapshot.project;
        confirmedProjectRef.current = snapshot.project;
        setProject(snapshot.project);
        setConfirmedProject(snapshot.project);
      })
      .catch((error) => {
        if (
          mountedRef.current &&
          selectionRevision === projectLoadRevisionRef.current &&
          activeProjectPathRef.current === path
        ) {
          setProjectLoadError(`Could not load project settings: ${errorMessage(error)}`);
        }
      })
      .finally(() => {
        if (
          mountedRef.current &&
          selectionRevision === projectLoadRevisionRef.current &&
          activeProjectPathRef.current === path
        ) {
          setProjectLoading(false);
          projectLoadPromiseRef.current = null;
        }
      });
    projectLoadPromiseRef.current = operation;
    return operation;
  }, []);

  const retryProject = useCallback(async () => {
    const path = activeProjectPathRef.current;
    if (!path) return;

    const selectionRevision = ++projectLoadRevisionRef.current;
    ++projectRevisionRef.current;
    const pendingProject = projectQueueRef.current;
    setProjectLoading(true);
    setProjectLoadError(null);

    const operation = pendingProject
      .then(() => getSettings(path))
      .then((snapshot) => {
        if (
          !mountedRef.current ||
          selectionRevision !== projectLoadRevisionRef.current ||
          activeProjectPathRef.current !== path
        ) return;
        projectRef.current = snapshot.project;
        confirmedProjectRef.current = snapshot.project;
        setProject(snapshot.project);
        setConfirmedProject(snapshot.project);
      })
      .catch((error) => {
        if (
          mountedRef.current &&
          selectionRevision === projectLoadRevisionRef.current &&
          activeProjectPathRef.current === path
        ) {
          setProjectLoadError(`Could not load project settings: ${errorMessage(error)}`);
        }
      })
      .finally(() => {
        if (
          mountedRef.current &&
          selectionRevision === projectLoadRevisionRef.current &&
          activeProjectPathRef.current === path
        ) {
          setProjectLoading(false);
          projectLoadPromiseRef.current = null;
        }
      });
    projectLoadPromiseRef.current = operation;
    return operation;
  }, []);

  const retry = useCallback(async () => {
    const revision = ++loadRevisionRef.current;
    const projectPath = activeProjectPathRef.current;
    const projectLoadRevision = projectPath
      ? ++projectLoadRevisionRef.current
      : projectLoadRevisionRef.current;
    // A load owns only scopes that have not mutated since it began. Waiting for
    // already-queued saves makes a manual retry read their confirmed server state;
    // the revision checks below protect saves that start after this snapshot.
    const globalRevision = globalRevisionRef.current;
    const projectRevision = projectRevisionRef.current;
    const pendingGlobal = globalQueueRef.current;
    const pendingProject = projectQueueRef.current;
    setLoading(true);
    if (projectPath) setProjectLoading(true);
    setLoadError(null);
    if (projectPath) setProjectLoadError(null);
    try {
      await Promise.all([pendingGlobal, pendingProject]);
      const snapshot = await getSettings(projectPath ?? undefined);
      if (!mountedRef.current || revision !== loadRevisionRef.current) return;
      if (globalRevision === globalRevisionRef.current) {
        globalRef.current = snapshot.global;
        confirmedGlobalRef.current = snapshot.global;
        setGlobal(snapshot.global);
        setConfirmedGlobal(snapshot.global);
      }
      if (
        projectRevision === projectRevisionRef.current &&
        projectPath === activeProjectPathRef.current &&
        projectLoadRevision === projectLoadRevisionRef.current
      ) {
        projectRef.current = snapshot.project;
        confirmedProjectRef.current = snapshot.project;
        setProject(snapshot.project);
        setConfirmedProject(snapshot.project);
      }
    } catch (error) {
      const ownsProjectLoad = projectPath === null || (
        projectPath === activeProjectPathRef.current &&
        projectLoadRevision === projectLoadRevisionRef.current
      );
      if (
        mountedRef.current &&
        revision === loadRevisionRef.current &&
        ownsProjectLoad
      ) {
        if (projectPath) {
          setProjectLoadError(`Could not load project settings: ${errorMessage(error)}`);
        } else {
          setLoadError(errorMessage(error));
        }
      }
    } finally {
      if (mountedRef.current && revision === loadRevisionRef.current) {
        setLoading(false);
        if (projectPath === activeProjectPathRef.current) setProjectLoading(false);
      }
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

    appliedThemeRef.current = validated.theme;
    setTheme(validated.theme);
    appliedLanguageRef.current = validated.language;
    setLanguage(validated.language);
    return true;
  }, []);

  useEffect(() => {
    applyUiPreferences(ui);
    appliedThemeRef.current = ui.theme;
    setTheme(ui.theme);
    appliedLanguageRef.current = ui.language;
    setLanguage(ui.language);
  }, []);

  // Resolve the accent per active project: a repo with its own override re-tints
  // the whole UI on switch, otherwise the global choice applies.
  useEffect(() => {
    applyAccent(effectiveAccent(ui.accent, ui.projectAccents, activeProjectPath));
  }, [ui.accent, ui.projectAccents, activeProjectPath]);

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
    const projectPath = activeProjectPathRef.current;
    if (!projectPath) {
      setSaveError("Select a project before changing project settings.");
      setSaveState("error");
      return;
    }
    const revision = ++projectRevisionRef.current;
    const optimistic = patchProject(projectRef.current, patch);
    projectRef.current = optimistic;
    setProject(optimistic);
    beginSave();

    const operation = projectQueueRef.current.then(() =>
      updateProjectSettings(projectPath, patch),
    );
    projectQueueRef.current = operation.then(() => undefined, () => undefined);
    try {
      const confirmed = await operation;
      if (!mountedRef.current) return;
      if (projectPath === activeProjectPathRef.current) {
        confirmedProjectRef.current = confirmed;
        setConfirmedProject(confirmed);
        if (revision === projectRevisionRef.current) {
          projectRef.current = confirmed;
          setProject(confirmed);
        }
      }
      finishSave();
    } catch (error) {
      if (!mountedRef.current) return;
      if (
        projectPath === activeProjectPathRef.current &&
        revision === projectRevisionRef.current
      ) {
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
    const projectPath = activeProjectPathRef.current;
    if (!projectPath) {
      setSaveError("Select a project before resetting project settings.");
      setSaveState("error");
      return;
    }
    const revision = ++projectRevisionRef.current;
    beginSave();
    const operation = projectQueueRef.current.then(() =>
      resetProjectSettings(projectPath),
    );
    projectQueueRef.current = operation.then(() => undefined, () => undefined);
    try {
      const confirmed = await operation;
      if (!mountedRef.current) return;
      if (projectPath === activeProjectPathRef.current) {
        confirmedProjectRef.current = confirmed;
        setConfirmedProject(confirmed);
        if (revision === projectRevisionRef.current) {
          projectRef.current = confirmed;
          setProject(confirmed);
        }
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
        activeProjectPath,
        projectLoading,
        projectLoadError,
        selectProject,
        retryProject,
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
  const value = useOptionalSettings();
  if (!value) throw new Error("useSettings must be used within SettingsProvider");
  return value;
}

export function useOptionalSettings(): SettingsContextValue | null {
  return useContext(SettingsContext);
}
