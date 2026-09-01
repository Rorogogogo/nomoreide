import { httpSkillsApi } from "./skills-http.js";
import type { SkillsApi } from "./skills-api.js";

const api: SkillsApi = httpSkillsApi;

export const { loadOneTimeSkillPrompt, searchSkills } = api;
export type {
  OneTimeSkillSelection,
  RemoteSkillResult,
  SkillsApi,
} from "./skills-api.js";
