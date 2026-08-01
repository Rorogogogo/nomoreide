import { httpSkillsApi } from "./skills-http.js";
import type { SkillsApi } from "./skills-api.js";
import { tauriSkillsApi } from "./skills-tauri.js";
import { isTauri } from "./tauri-bridge.js";

const api: SkillsApi = isTauri() ? tauriSkillsApi : httpSkillsApi;

export const { loadOneTimeSkillPrompt, searchSkills } = api;
export type {
  OneTimeSkillSelection,
  RemoteSkillResult,
  SkillsApi,
} from "./skills-api.js";
