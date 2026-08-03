/** Node HTTP-server implementation of {@link DatabaseApi} (the web/MCP backend). */
import { postFormForJson, requestJson } from "./client.js";
import type {
  DatabaseApi,
  DatabaseConnection,
  DatabaseCapabilities,
  DatabaseObject,
  DatabaseObjectDetails,
  DatabaseSchema,
  DetectedConnection,
  QueryResult,
  RowSample,
  TableRef,
  WriteOutcome,
  DeleteDatabaseRowsInput,
} from "./database-api.js";

export const httpDatabaseApi: DatabaseApi = {
  async listDatabases() {
    const res = await requestJson<{ ok: true; connections: DatabaseConnection[] }>(
      "/api/databases",
    );
    return res.connections;
  },

  async detectDatabases() {
    const res = await requestJson<{ ok: true; detected: DetectedConnection[] }>(
      "/api/databases/detect",
    );
    return res.detected;
  },

  async addDatabase(input) {
    await postFormForJson("/api/databases", input);
  },

  testDatabase(input) {
    return postFormForJson<{ ok: boolean; error?: string }>("/api/databases/test", input);
  },

  async deleteDatabase(name) {
    await requestJson(`/api/databases/${encodeURIComponent(name)}`, { method: "DELETE" });
  },

  async getDatabaseTables(name) {
    const res = await requestJson<{ ok: true; tables: TableRef[] }>(
      `/api/databases/${encodeURIComponent(name)}/tables`,
    );
    return res.tables;
  },

  async getDatabaseCapabilities(name) {
    const res = await requestJson<{ ok: true; capabilities: DatabaseCapabilities }>(
      `/api/databases/${encodeURIComponent(name)}/catalog/capabilities`,
    );
    return res.capabilities;
  },

  async getDatabaseSchemas(name) {
    const res = await requestJson<{ ok: true; schemas: DatabaseSchema[] }>(
      `/api/databases/${encodeURIComponent(name)}/catalog/schemas`,
    );
    return res.schemas;
  },

  async getDatabaseObjects(name, schema) {
    const res = await requestJson<{ ok: true; objects: DatabaseObject[] }>(
      `/api/databases/${encodeURIComponent(name)}/catalog/objects?schema=${encodeURIComponent(schema)}`,
    );
    return res.objects;
  },

  async getDatabaseObjectDetails(name, key) {
    const res = await requestJson<{ ok: true; details: DatabaseObjectDetails }>(
      `/api/databases/${encodeURIComponent(name)}/catalog/details?key=${encodeURIComponent(key)}`,
    );
    return res.details;
  },

  getDatabaseObjectRows(name, key, limit = 100, offset = 0) {
    return requestJson<{ ok: true } & RowSample & { object: DatabaseObject }>(
      `/api/databases/${encodeURIComponent(name)}/catalog/rows?key=${encodeURIComponent(key)}&limit=${limit}&offset=${offset}`,
    );
  },

  runDatabaseQuery(name, sql, limit = 100) {
    return postFormForJson<{ ok: true } & QueryResult>(
      `/api/databases/${encodeURIComponent(name)}/query`,
      { sql, limit },
    );
  },

  async setDatabaseWriteAccess(name, unlocked) {
    await postFormForJson(`/api/databases/${encodeURIComponent(name)}/write-access`, {
      unlocked: String(unlocked),
    });
  },

  executeDatabaseWrite(name, sql, mode) {
    return postFormForJson<{ ok: true } & WriteOutcome>(
      `/api/databases/${encodeURIComponent(name)}/execute`,
      { sql, mode },
    );
  },

  deleteDatabaseRows(name, input: DeleteDatabaseRowsInput) {
    return postFormForJson<{ ok: true } & WriteOutcome>(
      `/api/databases/${encodeURIComponent(name)}/catalog/rows/delete`,
      {
        key: input.objectKey,
        tuples: JSON.stringify(input.keys),
        mode: input.mode,
        expectedAffectedRows: input.expectedAffectedRows,
      },
    );
  },

  getDatabaseRows(name, table, limit = 100, offset = 0) {
    return requestJson<{ ok: true } & RowSample>(
      `/api/databases/${encodeURIComponent(name)}/rows?table=${encodeURIComponent(
        table,
      )}&limit=${limit}&offset=${offset}`,
    );
  },
};
