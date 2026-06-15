import { postFormForJson, requestJson } from "./client.js";
import {
  isTauri,
  tauri_listDatabases,
  tauri_queryDatabase,
  tauri_executeDatabase,
  tauri_listTables,
  tauri_registerDatabase,
  tauri_removeDatabase,
  tauri_setDatabaseWriteAccess,
} from "./tauri-bridge.js";

export type DatabaseEngine = "postgres" | "mysql" | "sqlite";

export interface DatabaseConnection {
  name: string;
  engine: DatabaseEngine;
  /** Password-masked URL (SQLite paths are returned as-is). */
  url: string;
  /** Whether the user has unlocked write access for this connection. */
  writeUnlocked: boolean;
}

export interface DetectedConnection {
  service: string;
  key: string;
  engine: DatabaseEngine;
  url: string;
  maskedUrl: string;
}

export interface TableRef {
  schema?: string;
  name: string;
  qualifiedName: string;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
}

export interface RowSample {
  engine: DatabaseEngine;
  table: TableRef;
  columns: ColumnInfo[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  limit: number;
  offset: number;
}

export async function listDatabases(): Promise<DatabaseConnection[]> {
  if (isTauri()) {
    const dbs = await tauri_listDatabases();
    return dbs as DatabaseConnection[];
  }
  const res = await requestJson<{ ok: true; connections: DatabaseConnection[] }>(
    "/api/databases",
  );
  return res.connections;
}

/** Not available in desktop mode — returns empty array. */
export async function detectDatabases(): Promise<DetectedConnection[]> {
  if (isTauri()) return [];
  const res = await requestJson<{ ok: true; detected: DetectedConnection[] }>(
    "/api/databases/detect",
  );
  return res.detected;
}

export async function addDatabase(input: {
  name: string;
  engine: DatabaseEngine;
  url: string;
}): Promise<void> {
  if (isTauri()) {
    await tauri_registerDatabase(input);
    return;
  }
  await postFormForJson("/api/databases", input);
}

export async function testDatabase(input: {
  engine: DatabaseEngine;
  url: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (isTauri()) {
    // Attempt a simple connection by listing tables on a dummy query.
    // If the connection fails, sqlx returns an error.
    try {
      await tauri_queryDatabase("__test__", "SELECT 1", 1);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
  return postFormForJson<{ ok: boolean; error?: string }>(
    "/api/databases/test",
    input,
  );
}

export async function deleteDatabase(name: string): Promise<void> {
  if (isTauri()) {
    await tauri_removeDatabase(name);
    return;
  }
  await requestJson(`/api/databases/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

export async function getDatabaseTables(name: string): Promise<TableRef[]> {
  if (isTauri()) {
    const tables = await tauri_listTables(name);
    return tables.map((t) => ({ name: t, qualifiedName: t }));
  }
  const res = await requestJson<{ ok: true; tables: TableRef[] }>(
    `/api/databases/${encodeURIComponent(name)}/tables`,
  );
  return res.tables;
}

export interface QueryResult {
  engine: DatabaseEngine;
  columns: ColumnInfo[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  /** True when the query produced more rows than the cap. */
  truncated: boolean;
}

export async function runDatabaseQuery(
  name: string,
  sql: string,
  limit = 100,
): Promise<QueryResult> {
  if (isTauri()) {
    const result = await tauri_queryDatabase(name, sql, limit) as {
      columns: string[];
      rows: unknown[][];
      rowCount: number;
    };
    const columns: ColumnInfo[] = result.columns.map((c) => ({
      name: c, dataType: "text", nullable: true, primaryKey: false,
    }));
    const rows: Array<Record<string, unknown>> = result.rows.map((row) => {
      const obj: Record<string, unknown> = {};
      result.columns.forEach((col, i) => { obj[col] = row[i]; });
      return obj;
    });
    return { engine: "sqlite", columns, rows, rowCount: result.rowCount, truncated: false };
  }
  return postFormForJson<{ ok: true } & QueryResult>(
    `/api/databases/${encodeURIComponent(name)}/query`,
    { sql, limit },
  );
}

export interface WriteOutcome {
  engine: DatabaseEngine;
  previewUnavailable: boolean;
  affectedRows?: number;
  rows?: Array<Record<string, unknown>>;
  columns?: ColumnInfo[];
  committed?: boolean;
}

/** Lock or unlock write access for a connection's SQL console. */
export async function setDatabaseWriteAccess(
  name: string,
  unlocked: boolean,
): Promise<void> {
  if (isTauri()) {
    await tauri_setDatabaseWriteAccess(name, unlocked);
    return;
  }
  await postFormForJson(`/api/databases/${encodeURIComponent(name)}/write-access`, {
    unlocked: String(unlocked),
  });
}

/** Run a write: `preview` rolls back (dry run), `commit` persists. */
export async function executeDatabaseWrite(
  name: string,
  sql: string,
  mode: "preview" | "commit",
): Promise<WriteOutcome> {
  if (isTauri()) {
    if (mode === "preview") {
      // Rust backend doesn't support transaction preview; report as unavailable.
      return { engine: "sqlite", previewUnavailable: true };
    }
    const affected = await tauri_executeDatabase(name, sql);
    return { engine: "sqlite", previewUnavailable: false, affectedRows: affected, committed: true };
  }
  return postFormForJson<{ ok: true } & WriteOutcome>(
    `/api/databases/${encodeURIComponent(name)}/execute`,
    { sql, mode },
  );
}

export async function getDatabaseRows(
  name: string,
  table: string,
  limit = 100,
  offset = 0,
): Promise<RowSample> {
  if (isTauri()) {
    const sql = offset > 0
      ? `SELECT * FROM ${table} LIMIT ${limit} OFFSET ${offset}`
      : `SELECT * FROM ${table} LIMIT ${limit}`;
    const result = await tauri_queryDatabase(name, sql, limit) as {
      columns: string[];
      rows: unknown[][];
      rowCount: number;
    };
    const columns: ColumnInfo[] = result.columns.map((c) => ({
      name: c, dataType: "text", nullable: true, primaryKey: false,
    }));
    const rows: Array<Record<string, unknown>> = result.rows.map((row) => {
      const obj: Record<string, unknown> = {};
      result.columns.forEach((col, i) => { obj[col] = row[i]; });
      return obj;
    });
    return {
      engine: "sqlite",
      table: { name: table, qualifiedName: table },
      columns,
      rows,
      rowCount: result.rowCount,
      limit,
      offset,
    };
  }
  return requestJson<{ ok: true } & RowSample>(
    `/api/databases/${encodeURIComponent(name)}/rows?table=${encodeURIComponent(
      table,
    )}&limit=${limit}&offset=${offset}`,
  );
}
