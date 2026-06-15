/** Node HTTP-server implementation of {@link DatabaseApi} (the web/MCP backend). */
import { postFormForJson, requestJson } from "./client.js";
import type {
  DatabaseApi,
  DatabaseConnection,
  DetectedConnection,
  QueryResult,
  RowSample,
  TableRef,
  WriteOutcome,
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

  getDatabaseRows(name, table, limit = 100, offset = 0) {
    return requestJson<{ ok: true } & RowSample>(
      `/api/databases/${encodeURIComponent(name)}/rows?table=${encodeURIComponent(
        table,
      )}&limit=${limit}&offset=${offset}`,
    );
  },
};
