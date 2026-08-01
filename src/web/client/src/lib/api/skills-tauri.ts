import {
  tauri_loadOneTimeSkillPrompt,
  tauri_searchSkills,
} from "./tauri-bridge.js";
import type { SkillsApi } from "./skills-api.js";

export const tauriSkillsApi: SkillsApi = {
  loadOneTimeSkillPrompt: tauri_loadOneTimeSkillPrompt,
  searchSkills: tauri_searchSkills,
};
