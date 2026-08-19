import {
  JetBrainsImportSessions,
  type JetBrainsDatabaseSelection,
  type JetBrainsImportSelection,
} from "../../core/jetbrains-import.js";
import { redactDatabaseError } from "../../core/db-peek.js";
import { publicConfig } from "../../core/public-config.js";
import { readJson, sendJson } from "../http-utils.js";
import { errorMessage, route, type Route } from "./context.js";

const sessions = new JetBrainsImportSessions();

export const jetBrainsImportRoutes: Route[] = [
  route("POST", "/api/import/jetbrains/scan", async ({ request, response, configStore }) => {
    const body = await readJson(request);
    if (typeof body.projectRoot !== "string" || !body.projectRoot.trim()) {
      sendJson(response, { ok: false, error: "projectRoot is required" }, 400);
      return;
    }
    try {
      const config = await configStore.load();
      const preview = await sessions.scan({
        projectRoot: body.projectRoot,
        includePersonal: body.includePersonal === true,
        existingNames: config.services.map((service) => service.name),
        existingDatabaseNames: config.databases.map((database) => database.name),
      });
      sendJson(response, { ok: true, preview });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 422);
    }
  }),

  route("POST", "/api/import/jetbrains/apply", async ({ request, response, configStore, dbPeek }) => {
    const body = await readJson(request);
    if (typeof body.sessionId !== "string" || !Array.isArray(body.selections)) {
      sendJson(response, { ok: false, error: "sessionId and selections are required" }, 400);
      return;
    }
    try {
      const selections = parseSelections(body.selections);
      const databaseSelections = parseDatabaseSelections(body.databases);
      const imported = await sessions.consume(body.sessionId, selections, databaseSelections);
      for (const database of imported.databases) {
        if (database.test) {
          try {
            await dbPeek.test(database.definition.engine, database.definition.url);
          } catch (error) {
            throw new Error(
              redactDatabaseError(
                database.definition.engine,
                database.definition.url,
                error,
              ),
            );
          }
        }
      }
      const config = await configStore.importProjectSetup({
        services: imported.services,
        databases: imported.databases,
      });
      sessions.complete(body.sessionId);
      sendJson(response, {
        ok: true,
        imported: imported.services.map((service) => service.definition.name),
        importedDatabases: imported.databases.map((database) => database.definition.name),
        config: publicConfig(config),
      });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 409);
    }
  }),
];

function parseSelections(value: unknown[]): JetBrainsImportSelection[] {
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Invalid import selection.");
    const { id, conflict, name, command, args, cwd } = entry as Record<string, unknown>;
    if (
      typeof id !== "string" ||
      (conflict !== "add" &&
        conflict !== "skip" &&
        conflict !== "replace" &&
        conflict !== "rename") ||
      (name !== undefined && typeof name !== "string")
      || (command !== undefined && typeof command !== "string")
      || (cwd !== undefined && typeof cwd !== "string")
      || (args !== undefined && (!Array.isArray(args) || args.some((value) => typeof value !== "string")))
    ) {
      throw new Error("Invalid import selection.");
    }
    return {
      id,
      conflict,
      ...(typeof name === "string" ? { name } : {}),
      ...(typeof command === "string" ? { command } : {}),
      ...(Array.isArray(args) ? { args: args as string[] } : {}),
      ...(typeof cwd === "string" ? { cwd } : {}),
    };
  });
}

function parseDatabaseSelections(value: unknown): JetBrainsDatabaseSelection[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Invalid database import selections.");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Invalid database import selection.");
    const { id, conflict, name, username, password, test } = entry as Record<string, unknown>;
    if (
      typeof id !== "string" ||
      (conflict !== "add" &&
        conflict !== "skip" &&
        conflict !== "replace" &&
        conflict !== "rename") ||
      (name !== undefined && typeof name !== "string") ||
      (username !== undefined && typeof username !== "string") ||
      (password !== undefined && typeof password !== "string") ||
      (test !== undefined && typeof test !== "boolean")
    ) {
      throw new Error("Invalid database import selection.");
    }
    return {
      id,
      conflict,
      ...(typeof name === "string" ? { name } : {}),
      ...(typeof username === "string" ? { username } : {}),
      ...(typeof password === "string" ? { password } : {}),
      ...(typeof test === "boolean" ? { test } : {}),
    };
  });
}
