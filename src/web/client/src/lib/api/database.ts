import { postFormForJson, requestJson } from "./client.js";

export type DatabaseEngine = "postgres" | "mysql" | "sqlite";

export interface DatabaseConnection {
  name: string;
  engine: DatabaseEngine;
  /** Password-masked URL (SQLite paths are returned as-is). */
  url: string;
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

/** Build the "explain this row to the agent" prompt from already-fetched data. */
export function buildRowPrompt(
  connection: string,
  engine: DatabaseEngine,
  table: TableRef,
  columns: ColumnInfo[],
  row: Record<string, unknown>,
): string {
  const schemaLines = columns
    .map(
      (col) =>
        `- ${col.name}: ${col.dataType}${col.primaryKey ? " (PK)" : ""}${
          col.nullable ? "" : " NOT NULL"
        }`,
    )
    .join("\n");
  return [
    `I'm looking at a row in my ${engine} database (connection "${connection}", table \`${table.qualifiedName}\`).`,
    "",
    "## Table schema",
    schemaLines,
    "",
    "## Row",
    "```json",
    JSON.stringify(row, null, 2),
    "```",
    "",
    "Explain what this row represents and anything notable about its values.",
  ].join("\n");
}
