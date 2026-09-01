import type { SettingsApi } from "./settings-api.js";
import { httpSettingsApi } from "./settings-http.js";

const api: SettingsApi = httpSettingsApi;

export const {
  getSettings,
  updateGlobalSettings,
  updateProjectSettings,
  resetGlobalSettings,
  resetProjectSettings,
} = api;

export type {
  AppSettings,
  AppSettingsPatch,
  ProjectPreferences,
  ProjectPreferencesPatch,
  SettingsApi,
  SettingsSnapshot,
} from "./settings-api.js";
