import { mergeStoredPassword } from "../../core/db-peek.js";
import type { DatabaseEngine } from "../../core/types.js";
import {
  readForm,
  requiredFormValue,
  sendJson,
} from "../http-utils.js";
import { patternRoute, route, type Route } from "./context.js";

const ENGINES: DatabaseEngine[] = ["postgres", "mysql", "sqlite"];

function parseEngine(value: string): DatabaseEngine {
  if (!ENGINES.includes(value as DatabaseEngine)) {
    throw new Error(`Unsupported engine "${value}". Use one of: ${ENGINES.join(", ")}.`);
  }
  return value as DatabaseEngine;
}

/** DB Peek: read-only browser for registered Postgres / MySQL / SQLite connections. */
export const databaseRoutes: Route[] = [
  route("GET", "/api/databases", async ({ response, dbPeek }) => {
    sendJson(response, { ok: true, connections: await dbPeek.listConnections() });
  }),

  route("GET", "/api/databases/detect", async ({ response, dbPeek }) => {
    sendJson(response, { ok: true, detected: await dbPeek.detectFromEnv() });
  }),

  route("POST", "/api/databases", async ({ request, response, configStore }) => {
    const form = await readForm(request);
    const name = requiredFormValue(form, "name");
    const engine = parseEngine(requiredFormValue(form, "engine"));
    let url = requiredFormValue(form, "url");
    // Editing an existing connection: keep the stored password if this save
    // didn't include one (the client only ever has the masked URL).
    const existing = (await configStore.load()).databases.find(
      (db) => db.name === name,
    );
    if (existing) {
      url = mergeStoredPassword(engine, url, existing.url);
    }
    const config = await configStore.registerDatabase({ name, engine, url });
    sendJson(response, {
      ok: true,
      databases: config.databases.map((db) => ({
        name: db.name,
        engine: db.engine,
      })),
    });
  }),

  route("POST", "/api/databases/test", async ({ request, response, dbPeek }) => {
    const form = await readForm(request);
    const engine = parseEngine(requiredFormValue(form, "engine"));
    const url = requiredFormValue(form, "url");
    try {
      await dbPeek.test(engine, url);
      sendJson(response, { ok: true });
    } catch (error) {
      sendJson(
        response,
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        200,
      );
    }
  }),

  patternRoute(
    /^\/api\/databases\/([^/]+)$/,
    ["name"],
    async ({ request, response, params, configStore }) => {
      if (request.method !== "DELETE") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      await configStore.removeDatabase(decodeURIComponent(params.name));
      sendJson(response, { ok: true });
    },
  ),

  patternRoute(
    /^\/api\/databases\/([^/]+)\/tables$/,
    ["name"],
    async ({ request, response, params, dbPeek }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const tables = await dbPeek.listTables(decodeURIComponent(params.name));
      sendJson(response, { ok: true, tables });
    },
  ),

  patternRoute(
    /^\/api\/databases\/([^/]+)\/rows$/,
    ["name"],
    async ({ request, response, params, url, dbPeek }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const table = url.searchParams.get("table");
      if (!table) {
        sendJson(response, { ok: false, error: "table query param is required" }, 400);
        return;
      }
      const limitParam = Number(url.searchParams.get("limit"));
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 100;
      const offsetParam = Number(url.searchParams.get("offset"));
      const offset = Number.isFinite(offsetParam) && offsetParam > 0 ? offsetParam : 0;
      const sample = await dbPeek.sampleRows(
        decodeURIComponent(params.name),
        table,
        limit,
        offset,
      );
      sendJson(response, { ok: true, ...sample });
    },
  ),
];
