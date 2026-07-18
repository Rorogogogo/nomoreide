import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { appSettingsPatchSchema } from "../../core/app-settings.js";
import {
  ConfigValidationError,
  projectPreferencesPatchSchema,
} from "../../core/config-store.js";
import { sendJson } from "../http-utils.js";
import { route, type Route } from "./context.js";

export const settingsRoutes: Route[] = [
  route("GET", "/api/settings", async ({ appSettings, configStore, response }) => {
    await respond(response, async () => {
      const [global, project] = await Promise.all([
        appSettings.load(),
        configStore.getPreferences(),
      ]);
      return { ok: true, global, project };
    });
  }),

  route(
    "PATCH",
    "/api/settings/global",
    async ({ appSettings, request, response }) => {
      await respond(response, async () => {
        const patch = appSettingsPatchSchema.parse(
          await readJsonObject(request),
        );
        const global = await appSettings.update(patch);
        return { ok: true, global };
      });
    },
  ),

  route(
    "PATCH",
    "/api/settings/project",
    async ({ configStore, request, response }) => {
      await respond(response, async () => {
        const patch = projectPreferencesPatchSchema.parse(
          await readJsonObject(request),
        );
        const project = await configStore.updatePreferences(patch);
        return { ok: true, project };
      });
    },
  ),

  route(
    "POST",
    "/api/settings/global/reset",
    async ({ appSettings, response }) => {
      await respond(response, async () => ({
        ok: true,
        global: await appSettings.reset(),
      }));
    },
  ),

  route(
    "POST",
    "/api/settings/project/reset",
    async ({ configStore, response }) => {
      await respond(response, async () => ({
        ok: true,
        project: await configStore.resetPreferences(),
      }));
    },
  ),
];

async function respond(
  response: ServerResponse,
  operation: () => Promise<Record<string, unknown>>,
): Promise<void> {
  try {
    sendJson(response, await operation());
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof ConfigValidationError) {
      sendJson(response, { ok: false, error: error.message }, 400);
      return;
    }
    throw error;
  }
}

async function readJsonObject(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigValidationError("Request body must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigValidationError("Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}
