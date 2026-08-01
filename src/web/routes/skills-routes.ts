import {
  OneTimeSkillError,
  resolveOneTimeSkill,
  searchRemoteSkills,
} from "../../core/one-time-skills.js";
import { z } from "zod";
import { readJson, sendJson } from "../http-utils.js";
import { route, type Route } from "./context.js";

const useSkillSchema = z.object({
  skill: z.object({
    name: z.string().trim().min(1).max(200),
    source: z.string().trim().min(3).max(400),
  }).strict(),
}).strict();

export const skillsRoutes: Route[] = [
  route("GET", "/api/skills/search", async ({ response, url }) => {
    const query = url.searchParams.get("q") ?? "";
    try {
      const skills = await searchRemoteSkills(query);
      sendJson(response, { ok: true, skills });
    } catch (error) {
      if (error instanceof OneTimeSkillError) {
        const status =
          error.code === "invalid_query"
            ? 400
            : error.code === "timeout"
              ? 504
              : 502;
        sendJson(response, { ok: false, error: error.message, code: error.code }, status);
        return;
      }
      sendJson(response, { ok: false, error: "Skill search failed." }, 502);
    }
  }),
  route("POST", "/api/skills/use", async ({ request, response }) => {
    const parsed = useSkillSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      sendJson(response, { ok: false, error: "Invalid temporary skill request." }, 400);
      return;
    }
    try {
      const prompt = await resolveOneTimeSkill(parsed.data.skill);
      sendJson(response, { ok: true, prompt });
    } catch (error) {
      const message =
        error instanceof OneTimeSkillError
          ? error.message
          : "The temporary skill could not be loaded.";
      sendJson(response, { ok: false, error: message }, 422);
    }
  }),
];
