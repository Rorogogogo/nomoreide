import { requestJson } from "./client.js";
import type {
  RemoteSkillResult,
  SkillsApi,
} from "./skills-api.js";

export const httpSkillsApi: SkillsApi = {
  async searchSkills(query) {
    const response = await requestJson<{ ok: true; skills: RemoteSkillResult[] }>(
      `/api/skills/search?q=${encodeURIComponent(query)}`,
    );
    return response.skills;
  },
  async loadOneTimeSkillPrompt(skill) {
    const response = await requestJson<{ ok: true; prompt: string }>(
      "/api/skills/use",
      {
        body: JSON.stringify({ skill }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    return response.prompt;
  },
};
