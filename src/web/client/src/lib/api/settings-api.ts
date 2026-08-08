export interface AppSettings {
  version: 1;
  terminal: {
    fontSize: number;
    cursorStyle: "block" | "underline" | "bar";
    scrollback: number;
    copyOnSelect: boolean;
    confirmTerminate: boolean;
    smoothScroll: boolean;
  };
}

export interface AppSettingsPatch {
  terminal?: Partial<AppSettings["terminal"]>;
}

export interface ProjectPreferences {
  logs: {
    showTimestamps: boolean;
    wrapLines: boolean;
  };
  database: {
    confirmWrites: boolean;
    resultLimit: number;
  };
}

export interface ProjectPreferencesPatch {
  logs?: Partial<ProjectPreferences["logs"]>;
  database?: Partial<ProjectPreferences["database"]>;
}

export interface SettingsSnapshot {
  global: AppSettings;
  project: ProjectPreferences;
}

export interface SettingsApi {
  getSettings(projectPath?: string): Promise<SettingsSnapshot>;
  updateGlobalSettings(patch: AppSettingsPatch): Promise<AppSettings>;
  updateProjectSettings(
    projectPath: string,
    patch: ProjectPreferencesPatch,
  ): Promise<ProjectPreferences>;
  resetGlobalSettings(): Promise<AppSettings>;
  resetProjectSettings(projectPath: string): Promise<ProjectPreferences>;
}
