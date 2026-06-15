/**
 * Database API surface — the single contract both backends implement. See
 * {@link ../git-api} for the shared-interface seam rationale.
 */

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

export interface QueryResult {
  engine: DatabaseEngine;
  columns: ColumnInfo[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  /** True when the query produced more rows than the cap. */
  truncated: boolean;
}

export interface WriteOutcome {
  engine: DatabaseEngine;
  previewUnavailable: boolean;
  affectedRows?: number;
  rows?: Array<Record<string, unknown>>;
  columns?: ColumnInfo[];
  committed?: boolean;
}

export interface DatabaseApi {
  listDatabases(): Promise<DatabaseConnection[]>;
  /** Not available in desktop mode — returns empty array. */
  detectDatabases(): Promise<DetectedConnection[]>;
  addDatabase(input: { name: string; engine: DatabaseEngine; url: string }): Promise<void>;
  testDatabase(input: {
    engine: DatabaseEngine;
    url: string;
  }): Promise<{ ok: boolean; error?: string }>;
  deleteDatabase(name: string): Promise<void>;
  getDatabaseTables(name: string): Promise<TableRef[]>;
  runDatabaseQuery(name: string, sql: string, limit?: number): Promise<QueryResult>;
  /** Lock or unlock write access for a connection's SQL console. */
  setDatabaseWriteAccess(name: string, unlocked: boolean): Promise<void>;
  /** Run a write: `preview` rolls back (dry run), `commit` persists. */
  executeDatabaseWrite(
    name: string,
    sql: string,
    mode: "preview" | "commit",
  ): Promise<WriteOutcome>;
  getDatabaseRows(
    name: string,
    table: string,
    limit?: number,
    offset?: number,
  ): Promise<RowSample>;
}
