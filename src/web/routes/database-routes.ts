import { mergeStoredPassword, redactDatabaseError } from "../../core/db-peek.js";
import type { DatabaseEngine } from "../../core/types.js";
import {
  optionalFormValue,
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
    const config = await configStore.registerDatabase({
      name,
      engine,
      url,
      // Re-registering replaces the entry, so carry the unlock state forward.
      writeUnlocked: existing?.writeUnlocked,
      // Unlike the password, the client always knows the project assignment,
      // so the submitted value (or its absence) is authoritative.
      projectPath: optionalFormValue(form, "projectPath")?.trim() || undefined,
    });
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
        { ok: false, error: redactDatabaseError(engine, url, error) },
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
    /^\/api\/databases\/([^/]+)\/catalog\/capabilities$/,
    ["name"],
    async ({ request, response, params, dbPeek }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const capabilities = await dbPeek.capabilities(decodeURIComponent(params.name));
      sendJson(response, { ok: true, capabilities });
    },
  ),

  patternRoute(
    /^\/api\/databases\/([^/]+)\/catalog\/schemas$/,
    ["name"],
    async ({ request, response, params, dbPeek }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const schemas = await dbPeek.listSchemas(decodeURIComponent(params.name));
      sendJson(response, { ok: true, schemas });
    },
  ),

  patternRoute(
    /^\/api\/databases\/([^/]+)\/catalog\/objects$/,
    ["name"],
    async ({ request, response, params, url, dbPeek }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const schema = url.searchParams.get("schema");
      if (!schema) {
        sendJson(response, { ok: false, error: "schema query param is required" }, 400);
        return;
      }
      const objects = await dbPeek.listObjects(decodeURIComponent(params.name), schema);
      sendJson(response, { ok: true, objects });
    },
  ),

  patternRoute(
    /^\/api\/databases\/([^/]+)\/catalog\/details$/,
    ["name"],
    async ({ request, response, params, url, dbPeek }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const key = url.searchParams.get("key");
      if (!key) {
        sendJson(response, { ok: false, error: "key query param is required" }, 400);
        return;
      }
      const details = await dbPeek.objectDetails(decodeURIComponent(params.name), key);
      sendJson(response, { ok: true, details });
    },
  ),

  patternRoute(
    /^\/api\/databases\/([^/]+)\/catalog\/rows$/,
    ["name"],
    async ({ request, response, params, url, dbPeek }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const key = url.searchParams.get("key");
      if (!key) {
        sendJson(response, { ok: false, error: "key query param is required" }, 400);
        return;
      }
      const limit = Number(url.searchParams.get("limit")) || 100;
      const offset = Number(url.searchParams.get("offset")) || 0;
      const sample = await dbPeek.sampleObject(
        decodeURIComponent(params.name),
        key,
        limit,
        offset,
      );
      sendJson(response, { ok: true, ...sample });
    },
  ),

  // Delete rows by exact live-catalog primary-key tuples. This remains a
  // human-only write route and is gated by DbWrite's existing unlock flag.
  patternRoute(
    /^\/api\/databases\/([^/]+)\/catalog\/rows\/delete$/,
    ["name"],
    async ({ request, response, params, dbWrite }) => {
      if (request.method !== "POST") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      try {
        const form = await readForm(request);
        const key = requiredFormValue(form, "key");
        const mode = requiredFormValue(form, "mode");
        if (mode !== "preview" && mode !== "commit") {
          throw new Error('mode must be either "preview" or "commit"');
        }
        const tuples = parseDeleteTuples(requiredFormValue(form, "tuples"));
        const expectedRaw = optionalFormValue(form, "expectedAffectedRows");
        const expectedAffectedRows = expectedRaw === undefined
          ? undefined
          : Number(expectedRaw);
        const outcome = await dbWrite.deleteRows(
          decodeURIComponent(params.name),
          key,
          tuples,
          mode === "commit",
          expectedAffectedRows,
        );
        sendJson(response, { ok: true, ...outcome });
      } catch (error) {
        sendJson(
          response,
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          400,
        );
      }
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

  // Lock / unlock write access for a connection (human-only; never the agent).
  patternRoute(
    /^\/api\/databases\/([^/]+)\/write-access$/,
    ["name"],
    async ({ request, response, params, configStore }) => {
      if (request.method !== "POST") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const form = await readForm(request);
      const unlocked = requiredFormValue(form, "unlocked") === "true";
      await configStore.setDatabaseWriteAccess(
        decodeURIComponent(params.name),
        unlocked,
      );
      sendJson(response, { ok: true, writeUnlocked: unlocked });
    },
  ),

  // Run a write (preview = rolled-back dry run, commit = persisted). Gated by
  // the connection's unlock flag inside DbWrite.
  patternRoute(
    /^\/api\/databases\/([^/]+)\/execute$/,
    ["name"],
    async ({ request, response, params, dbWrite }) => {
      if (request.method !== "POST") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const form = await readForm(request);
      const sql = requiredFormValue(form, "sql");
      const commit = optionalFormValue(form, "mode") === "commit";
      try {
        const outcome = await dbWrite.execute(
          decodeURIComponent(params.name),
          sql,
          commit,
        );
        sendJson(response, { ok: true, ...outcome });
      } catch (error) {
        sendJson(
          response,
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          400,
        );
      }
    },
  ),

  patternRoute(
    /^\/api\/databases\/([^/]+)\/query$/,
    ["name"],
    async ({ request, response, params, dbPeek }) => {
      if (request.method !== "POST") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const form = await readForm(request);
      const sql = requiredFormValue(form, "sql");
      const limitRaw = optionalFormValue(form, "limit");
      const limitParam = Number(limitRaw);
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 100;
      try {
        const result = await dbPeek.runQuery(
          decodeURIComponent(params.name),
          sql,
          limit,
        );
        sendJson(response, { ok: true, ...result });
      } catch (error) {
        // Bad SQL / read-only violations are user errors — surface the message
        // inline rather than as a 500.
        sendJson(
          response,
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          400,
        );
      }
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

function parseDeleteTuples(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("tuples must be a valid JSON array");
  }
}
