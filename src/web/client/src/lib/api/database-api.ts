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
  /** Project directory the connection is classified under; absent = shared. */
  projectPath?: string;
}

export interface DetectedConnection {
  service: string;
  /** The service's working directory (absent from older/desktop backends). */
  cwd?: string;
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

export type DatabaseObjectKind =
  | "table"
  | "view"
  | "materializedView"
  | "function"
  | "procedure"
  | "sequence";

export interface DatabaseCapabilities {
  objectKinds: DatabaseObjectKind[];
  tableDetails: Array<"columns" | "indexes" | "constraints" | "triggers">;
}

export interface DatabaseSchema { name: string }

export interface DatabaseObject {
  key: string;
  schema: string;
  name: string;
  kind: DatabaseObjectKind;
  qualifiedName: string;
  nativeId?: string;
}

export interface DatabaseObjectDetails {
  object: DatabaseObject;
  columns: ColumnInfo[];
  indexes: Array<{ name: string; definition: string; unique: boolean }>;
  constraints: Array<{ name: string; type: string; definition: string }>;
  triggers: Array<{ name: string; definition: string }>;
  definition?: string;
  createScript?: string;
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

export type DatabaseRowKeyValue = string | number | boolean;

export interface DeleteDatabaseRowsInput {
  objectKey: string;
  keys: Array<Record<string, DatabaseRowKeyValue>>;
  mode: "preview" | "commit";
  expectedAffectedRows?: number;
}

export interface DatabaseApi {
  listDatabases(): Promise<DatabaseConnection[]>;
  /** Not available in desktop mode — returns empty array. */
  detectDatabases(): Promise<DetectedConnection[]>;
  addDatabase(input: {
    name: string;
    engine: DatabaseEngine;
    url: string;
    /** Omit or pass empty to leave the connection unassigned. */
    projectPath?: string;
  }): Promise<void>;
  testDatabase(input: {
    engine: DatabaseEngine;
    url: string;
  }): Promise<{ ok: boolean; error?: string }>;
  deleteDatabase(name: string): Promise<void>;
  getDatabaseTables(name: string): Promise<TableRef[]>;
  getDatabaseCapabilities(name: string): Promise<DatabaseCapabilities>;
  getDatabaseSchemas(name: string): Promise<DatabaseSchema[]>;
  getDatabaseObjects(name: string, schema: string): Promise<DatabaseObject[]>;
  getDatabaseObjectDetails(name: string, key: string): Promise<DatabaseObjectDetails>;
  getDatabaseObjectRows(
    name: string,
    key: string,
    limit?: number,
    offset?: number,
  ): Promise<RowSample & { object: DatabaseObject }>;
  runDatabaseQuery(name: string, sql: string, limit?: number): Promise<QueryResult>;
  /** Lock or unlock write access for a connection's SQL console. */
  setDatabaseWriteAccess(name: string, unlocked: boolean): Promise<void>;
  /** Run a write: `preview` rolls back (dry run), `commit` persists. */
  executeDatabaseWrite(
    name: string,
    sql: string,
    mode: "preview" | "commit",
  ): Promise<WriteOutcome>;
  /** Delete table rows by server-validated primary keys through the guarded write path. */
  deleteDatabaseRows(
    name: string,
    input: DeleteDatabaseRowsInput,
  ): Promise<WriteOutcome>;
  getDatabaseRows(
    name: string,
    table: string,
    limit?: number,
    offset?: number,
  ): Promise<RowSample>;
}
