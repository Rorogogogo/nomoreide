import { requestJson } from "./client.js";
import type {
  AppSettings,
  AppSettingsPatch,
  ProjectPreferences,
  ProjectPreferencesPatch,
  SettingsApi,
  SettingsSnapshot,
} from "./settings-api.js";

const jsonRequest = (method: "PATCH" | "POST", body?: unknown): RequestInit => ({
  method,
  headers: body === undefined ? undefined : { "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const httpSettingsApi: SettingsApi = {
  async getSettings(projectPath) {
    const path = projectPath === undefined
      ? "/api/settings"
      : `/api/settings?projectPath=${encodeURIComponent(projectPath)}`;
    const response = await requestJson<{ ok: true } & SettingsSnapshot>(path);
    return { global: response.global, project: response.project };
  },

  async updateGlobalSettings(patch: AppSettingsPatch) {
    const response = await requestJson<{ ok: true; global: AppSettings }>(
      "/api/settings/global",
      jsonRequest("PATCH", patch),
    );
    return response.global;
  },

  async updateProjectSettings(projectPath, patch: ProjectPreferencesPatch) {
    const response = await requestJson<{ ok: true; project: ProjectPreferences }>(
      `/api/settings/project?projectPath=${encodeURIComponent(projectPath)}`,
      jsonRequest("PATCH", patch),
    );
    return response.project;
  },

  async resetGlobalSettings() {
    const response = await requestJson<{ ok: true; global: AppSettings }>(
      "/api/settings/global/reset",
      jsonRequest("POST"),
    );
    return response.global;
  },

  async resetProjectSettings(projectPath) {
    const response = await requestJson<{ ok: true; project: ProjectPreferences }>(
      `/api/settings/project/reset?projectPath=${encodeURIComponent(projectPath)}`,
      jsonRequest("POST"),
    );
    return response.project;
  },
};
