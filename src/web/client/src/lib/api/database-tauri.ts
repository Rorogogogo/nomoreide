/**
 * Rust-core implementation of {@link DatabaseApi}, over Tauri `invoke()` (desktop).
 * The Rust backend returns positional column/row arrays and has no
 * detect/preview support, so those degrade here.
 */
import {
  tauri_listDatabases,
  tauri_queryDatabase,
  tauri_executeDatabase,
  tauri_listTables,
  tauri_registerDatabase,
  tauri_removeDatabase,
  tauri_setDatabaseWriteAccess,
} from "./tauri-bridge.js";
import type { ColumnInfo, DatabaseApi, DatabaseConnection } from "./database-api.js";

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

  async testDatabase() {
    // Attempt a simple connection; sqlx surfaces failures as a thrown error.
    try {
      await tauri_queryDatabase("__test__", "SELECT 1", 1);
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

  async runDatabaseQuery(name, sql, limit = 100) {
    const result = (await tauri_queryDatabase(name, sql, limit)) as RustQueryResult;
    const { columns, rows, rowCount } = mapRustResult(result);
    return { engine: "sqlite", columns, rows, rowCount, truncated: false };
  },

  async setDatabaseWriteAccess(name, unlocked) {
    await tauri_setDatabaseWriteAccess(name, unlocked);
  },

  async executeDatabaseWrite(name, sql, mode) {
    if (mode === "preview") {
      // Rust backend doesn't support transaction preview; report as unavailable.
      return { engine: "sqlite", previewUnavailable: true };
    }
    const affected = await tauri_executeDatabase(name, sql);
    return { engine: "sqlite", previewUnavailable: false, affectedRows: affected, committed: true };
  },

  async getDatabaseRows(name, table, limit = 100, offset = 0) {
    const sql =
      offset > 0
        ? `SELECT * FROM ${table} LIMIT ${limit} OFFSET ${offset}`
        : `SELECT * FROM ${table} LIMIT ${limit}`;
    const result = (await tauri_queryDatabase(name, sql, limit)) as RustQueryResult;
    const { columns, rows, rowCount } = mapRustResult(result);
    return {
      engine: "sqlite",
      table: { name: table, qualifiedName: table },
      columns,
      rows,
      rowCount,
      limit,
      offset,
    };
  },
};
