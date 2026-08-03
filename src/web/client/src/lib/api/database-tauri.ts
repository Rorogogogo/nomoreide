/**
 * Rust-core implementation of {@link DatabaseApi}, over Tauri `invoke()` (desktop).
 * The Rust backend returns positional column/row arrays and has no
 * detect/preview support, so those degrade here.
 */
import {
  tauri_listDatabases,
  tauri_queryDatabase,
  tauri_executeDatabase,
  tauri_deleteDatabaseRows,
  tauri_databaseCapabilities,
  tauri_getDatabaseObjectDetails,
  tauri_listDatabaseObjects,
  tauri_listDatabaseSchemas,
  tauri_listTables,
  tauri_registerDatabase,
  tauri_removeDatabase,
  tauri_setDatabaseWriteAccess,
  tauri_sampleDatabaseObject,
  tauri_testDatabaseConnection,
} from "./tauri-bridge.js";
import type {
  ColumnInfo,
  DatabaseApi,
  DatabaseCapabilities,
  DatabaseConnection,
  DatabaseObject,
  DatabaseObjectDetails,
  DatabaseSchema,
  RowSample,
} from "./database-api.js";

interface RustQueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
}

/** Map the Rust backend's positional column/row arrays into keyed objects. */
function mapRustResult(result: RustQueryResult): {
  columns: ColumnInfo[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
} {
  const columns: ColumnInfo[] = result.columns.map((c) => ({
    name: c,
    dataType: "text",
    nullable: true,
    primaryKey: false,
  }));
  const rows: Array<Record<string, unknown>> = result.rows.map((row) => {
    const obj: Record<string, unknown> = {};
    result.columns.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
  return { columns, rows, rowCount: result.rowCount };
}

export const tauriDatabaseApi: DatabaseApi = {
  async listDatabases() {
    const dbs = await tauri_listDatabases();
    return dbs as DatabaseConnection[];
  },

  detectDatabases: async () => [],

  async addDatabase(input) {
    await tauri_registerDatabase(input);
  },

  async testDatabase(input) {
    try {
      await tauri_testDatabaseConnection(input.engine, input.url);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },

  async deleteDatabase(name) {
    await tauri_removeDatabase(name);
  },

  async getDatabaseTables(name) {
    const tables = await tauri_listTables(name);
    return tables.map((t) => ({ name: t, qualifiedName: t }));
  },

  async getDatabaseCapabilities(name) {
    return (await tauri_databaseCapabilities(name)) as DatabaseCapabilities;
  },

  async getDatabaseSchemas(name) {
    return (await tauri_listDatabaseSchemas(name)) as DatabaseSchema[];
  },

  async getDatabaseObjects(name, schema) {
    return (await tauri_listDatabaseObjects(name, schema)) as DatabaseObject[];
  },

  async getDatabaseObjectDetails(name, key) {
    return (await tauri_getDatabaseObjectDetails(name, key)) as DatabaseObjectDetails;
  },

  async getDatabaseObjectRows(name, key, limit = 100, offset = 0) {
    return (await tauri_sampleDatabaseObject(name, key, limit, offset)) as RowSample & {
      object: DatabaseObject;
    };
  },

  async runDatabaseQuery(name, sql, limit = 100) {
    const result = (await tauri_queryDatabase(name, sql, limit)) as RustQueryResult;
    const { columns, rows, rowCount } = mapRustResult(result);
    const engine = (await this.listDatabases()).find((database) => database.name === name)?.engine ?? "sqlite";
    return { engine, columns, rows, rowCount, truncated: false };
  },

  async setDatabaseWriteAccess(name, unlocked) {
    await tauri_setDatabaseWriteAccess(name, unlocked);
  },

  async executeDatabaseWrite(name, sql, mode) {
    return (await tauri_executeDatabase(name, sql, mode)) as import("./database-api.js").WriteOutcome;
  },

  async deleteDatabaseRows(name, input) {
    return (await tauri_deleteDatabaseRows(name, input)) as import("./database-api.js").WriteOutcome;
  },

  async getDatabaseRows(name, table, limit = 100, offset = 0) {
    const schemas = (await tauri_listDatabaseSchemas(name)) as DatabaseSchema[];
    for (const schema of schemas) {
      const objects = (await tauri_listDatabaseObjects(name, schema.name)) as DatabaseObject[];
      const object = objects.find((candidate) => candidate.qualifiedName === table);
      if (object) return (await tauri_sampleDatabaseObject(name, object.key, limit, offset)) as RowSample;
    }
    throw new Error(`Table "${table}" not found.`);
  },
};
