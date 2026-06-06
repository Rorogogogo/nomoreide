import { postFormForJson, requestJson } from "./client.js";

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
  /** The page window applied server-side, so the UI can paginate. */
  limit: number;
  offset: number;
}

export async function listDatabases(): Promise<DatabaseConnection[]> {
  const res = await requestJson<{ ok: true; connections: DatabaseConnection[] }>(
    "/api/databases",
  );
  return res.connections;
}

export async function detectDatabases(): Promise<DetectedConnection[]> {
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
  await postFormForJson("/api/databases", input);
}

export async function testDatabase(input: {
  engine: DatabaseEngine;
  url: string;
}): Promise<{ ok: boolean; error?: string }> {
  return postFormForJson<{ ok: boolean; error?: string }>(
    "/api/databases/test",
    input,
  );
}

export async function deleteDatabase(name: string): Promise<void> {
  await requestJson(`/api/databases/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

export async function getDatabaseTables(name: string): Promise<TableRef[]> {
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
  return postFormForJson<{ ok: true } & QueryResult>(
    `/api/databases/${encodeURIComponent(name)}/query`,
    { sql, limit },
  );
}

export interface WriteOutcome {
  engine: DatabaseEngine;
  /** True when a preview couldn't be run (e.g. MySQL DDL auto-commits). */
  previewUnavailable: boolean;
  /** Rows affected/returned — absent when previewUnavailable. */
  affectedRows?: number;
  rows?: Array<Record<string, unknown>>;
  columns?: ColumnInfo[];
  /** True when the run was committed; false for a rolled-back preview. */
  committed?: boolean;
}

/** Lock or unlock write access for a connection's SQL console. */
export async function setDatabaseWriteAccess(
  name: string,
  unlocked: boolean,
): Promise<void> {
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
  return requestJson<{ ok: true } & RowSample>(
    `/api/databases/${encodeURIComponent(name)}/rows?table=${encodeURIComponent(
      table,
    )}&limit=${limit}&offset=${offset}`,
  );
}
