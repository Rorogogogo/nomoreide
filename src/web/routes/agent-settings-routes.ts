import { z } from "zod";
import {
  readAgentSettings,
  setAgentModel,
  writeAgentSettings,
} from "../../core/agent-settings.js";
import { readJson, sendJson } from "../http-utils.js";
import { errorMessage, patternRoute, type Route } from "./context.js";

const agentSchema = z.enum(["claude", "codex", "antigravity"]);

const writeBodySchema = z.object({ content: z.string() });
const modelBodySchema = z.object({ model: z.string() });

/**
 * Agent settings files (dialog in Agent Env): GET returns the raw file plus a
 * parsed model hint; PUT replaces the whole file; POST /model does the curated
 * model switch. All writes validate + back up first (core/agent-settings.ts).
 * The dialog fetches on open — mock handlers live in apps/website/src/mock-api.ts.
 */
export const agentSettingsRoutes: Route[] = [
  patternRoute(
    /^\/api\/agent-env\/settings\/([^/]+)$/,
    ["agent"],
    async ({ request, response, params }) => {
      const agent = agentSchema.safeParse(params.agent);
      if (!agent.success) {
        sendJson(response, { ok: false, error: "Unknown agent." }, 400);
        return;
      }
      try {
        if (request.method === "GET") {
          sendJson(response, { ok: true, settings: await readAgentSettings(agent.data) });
          return;
        }
        if (request.method === "PUT") {
          const body = writeBodySchema.safeParse(await readJson(request));
          if (!body.success) {
            sendJson(response, { ok: false, error: "Invalid settings body." }, 400);
            return;
          }
          const { backup, ...settings } = await writeAgentSettings(
            agent.data,
            body.data.content,
          );
          sendJson(response, { ok: true, settings, backup });
          return;
        }
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
      } catch (error) {
        const message = errorMessage(error);
        sendJson(response, { ok: false, error: message }, message.startsWith("Not valid") ? 400 : 500);
      }
    },
  ),

  patternRoute(
    /^\/api\/agent-env\/settings\/([^/]+)\/model$/,
    ["agent"],
    async ({ request, response, params }) => {
      if (request.method !== "POST") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const agent = agentSchema.safeParse(params.agent);
      if (!agent.success) {
        sendJson(response, { ok: false, error: "Unknown agent." }, 400);
        return;
      }
      const body = modelBodySchema.safeParse(await readJson(request));
      if (!body.success) {
        sendJson(response, { ok: false, error: "Invalid model body." }, 400);
        return;
      }
      try {
        const { backup, ...settings } = await setAgentModel(agent.data, body.data.model);
        sendJson(response, { ok: true, settings, backup });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 500);
      }
    },
  ),
];
