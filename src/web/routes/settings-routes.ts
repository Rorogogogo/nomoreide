import type { IncomingMessage, ServerResponse } from "node:http";
import { lstat, realpath } from "node:fs/promises";
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
        const projectScope = await projectConfigScope(configStore, url, false);
        const [global, project] = await Promise.all([
          appSettings.load(),
          projectScope
            ? projectScope.store.getPreferences()
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
        const patch = projectPreferencesPatchSchema.parse(
          await readJsonObject(request),
        );
        const projectScope = await projectConfigScope(
          configStore,
          url,
          true,
          true,
        );
        const project = await withRevalidatedProjectScope(
          configStore,
          url,
          projectScope.root,
          (store) => store.updatePreferences(patch),
        );
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
      await respond(response, async () => {
        const projectScope = await projectConfigScope(
          configStore,
          url,
          true,
          true,
        );
        return {
          ok: true,
          project: await withRevalidatedProjectScope(
            configStore,
            url,
            projectScope.root,
            (store) => store.resetPreferences(),
          ),
        };
      });
    },
  ),
];

interface ProjectConfigScope {
  root: string;
  store: ConfigStore;
}

async function projectConfigScope(
  registryStore: ConfigStore,
  url: URL,
  required: true,
  forWrite?: boolean,
): Promise<ProjectConfigScope>;
async function projectConfigScope(
  registryStore: ConfigStore,
  url: URL,
  required: false,
  forWrite?: boolean,
): Promise<ProjectConfigScope | undefined>;
async function projectConfigScope(
  registryStore: ConfigStore,
  url: URL,
  required: boolean,
  forWrite = false,
): Promise<ProjectConfigScope | undefined> {
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
      if (forWrite) {
        await requireDirectProjectDirectory(requestedPath, repository.path);
      }
      return {
        root: registeredCanonicalPath,
        store: new ConfigStore(
          join(registeredCanonicalPath, "nomoreide.config.json"),
        ),
      };
    }
  }

  throw new ConfigValidationError(
    "projectPath must exactly match a registered repository.",
  );
}

async function withRevalidatedProjectScope<T>(
  registryStore: ConfigStore,
  url: URL,
  expectedRoot: string,
  mutation: (store: ConfigStore) => Promise<T>,
): Promise<T> {
  // Node has no portable openat/dirfd mutation API. Rechecking here closes the
  // request-body delay window and keeps the remaining same-user rename race as
  // short as possible, but cannot make directory identity and the later write
  // one atomic filesystem operation.
  const currentScope = await projectConfigScope(registryStore, url, true, true);
  if (currentScope.root !== expectedRoot) {
    throw new ConfigValidationError("Registered project scope changed.");
  }
  return mutation(currentScope.store);
}

async function requireDirectProjectDirectory(
  requestedPath: string,
  registeredPath: string,
): Promise<void> {
  try {
    const [requestedStats, registeredStats] = await Promise.all([
      lstat(resolve(requestedPath)),
      lstat(resolve(registeredPath)),
    ]);
    if (!requestedStats.isDirectory() || !registeredStats.isDirectory()) {
      throw new Error("Project root is not a direct directory.");
    }
  } catch {
    throw new ConfigValidationError(
      "Project writes require an unchanged registered directory.",
    );
  }
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
