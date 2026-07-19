import type { IncomingMessage, ServerResponse } from "node:http";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { appSettingsPatchSchema } from "../../core/app-settings.js";
import {
  ConfigStore,
  ConfigValidationError,
  DEFAULT_PROJECT_PREFERENCES,
  projectPreferencesPatchSchema,
} from "../../core/config-store.js";
import { sendJson } from "../http-utils.js";
import { route, type Route } from "./context.js";

export const settingsRoutes: Route[] = [
  route(
    "GET",
    "/api/settings",
    async ({ appSettings, configStore, response, url }) => {
      await respond(response, async () => {
        const projectStore = await projectConfigStore(configStore, url, false);
        const [global, project] = await Promise.all([
          appSettings.load(),
          projectStore
            ? projectStore.getPreferences()
            : Promise.resolve(structuredClone(DEFAULT_PROJECT_PREFERENCES)),
        ]);
        return { ok: true, global, project };
      });
    },
  ),

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
    async ({ configStore, request, response, url }) => {
      await respond(response, async () => {
        const projectStore = await projectConfigStore(configStore, url, true);
        const patch = projectPreferencesPatchSchema.parse(
          await readJsonObject(request),
        );
        const project = await projectStore.updatePreferences(patch);
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
    async ({ configStore, response, url }) => {
      await respond(response, async () => ({
        ok: true,
        project: await (
          await projectConfigStore(configStore, url, true)
        ).resetPreferences(),
      }));
    },
  ),
];

async function projectConfigStore(
  registryStore: ConfigStore,
  url: URL,
  required: true,
): Promise<ConfigStore>;
async function projectConfigStore(
  registryStore: ConfigStore,
  url: URL,
  required: false,
): Promise<ConfigStore | undefined>;
async function projectConfigStore(
  registryStore: ConfigStore,
  url: URL,
  required: boolean,
): Promise<ConfigStore | undefined> {
  const rawProjectPath = url.searchParams.get("projectPath");
  if (rawProjectPath === null) {
    if (required) {
      throw new ConfigValidationError("projectPath is required.");
    }
    return undefined;
  }
  const requestedPath = rawProjectPath.trim();
  if (!requestedPath) {
    throw new ConfigValidationError("projectPath must not be empty.");
  }

  const requestedCanonicalPath = await canonicalProjectPath(requestedPath);
  const registry = await registryStore.load();
  for (const repository of registry.gitRepositories) {
    let registeredCanonicalPath: string;
    try {
      registeredCanonicalPath = await realpath(resolve(repository.path));
    } catch {
      continue;
    }
    if (registeredCanonicalPath === requestedCanonicalPath) {
      return new ConfigStore(
        join(registeredCanonicalPath, "nomoreide.config.json"),
      );
    }
  }

  throw new ConfigValidationError(
    "projectPath must exactly match a registered repository.",
  );
}

async function canonicalProjectPath(projectPath: string): Promise<string> {
  try {
    return await realpath(resolve(projectPath));
  } catch {
    throw new ConfigValidationError(
      "projectPath must be an existing registered repository.",
    );
  }
}

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
