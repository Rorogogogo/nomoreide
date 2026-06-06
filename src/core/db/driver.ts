import type { DatabaseEngine } from "../types.js";

/** A table the user can browse. `schema` is undefined for SQLite. */
export interface TableRef {
  schema?: string;
  name: string;
  /** Stable key used by the API/UI, e.g. "public.users" or "users". */
  qualifiedName: string;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
}

export interface RowSample {
  columns: ColumnInfo[];
  rows: Array<Record<string, unknown>>;
  /** Number of rows returned (≤ requested limit). */
  rowCount: number;
  /** The page window actually applied, echoed back so the UI can paginate. */
  limit: number;
  offset: number;
}

/** Result of running a user-authored read-only query through the SQL console. */
export interface QueryResult {
  columns: ColumnInfo[];
  rows: Array<Record<string, unknown>>;
  /** Number of rows returned (≤ the row cap). */
  rowCount: number;
  /** True when the query produced more rows than the cap; the UI flags it. */
  truncated: boolean;
}

/**
 * Read-only access to a single database. Implementations enforce read-only at
 * the connection/transaction level: `runQuery` accepts user SQL but the server
 * itself rejects any write — there is no write passthrough.
 */
export interface DbDriver {
  readonly engine: DatabaseEngine;
  /** Throws if the connection cannot be established. */
  testConnection(): Promise<void>;
  listTables(): Promise<TableRef[]>;
  sampleRows(table: TableRef, limit: number, offset?: number): Promise<RowSample>;
  /** Run an arbitrary SELECT-style statement in a read-only context. */
  runQuery(sql: string, maxRows: number): Promise<QueryResult>;
  close(): Promise<void>;
}

/** Outcome of a write run — previewed (rolled back) or committed. */
export interface WriteResult {
  /** Rows the statement affected (INSERT/UPDATE/DELETE) or returned (SELECT). */
  affectedRows: number;
  /** Rows produced by a SELECT or RETURNING clause, if any. */
  rows: Array<Record<string, unknown>>;
  columns: ColumnInfo[];
  /** True when committed; false when this was a rolled-back preview. */
  committed: boolean;
}

/**
 * Write-capable view of a database, deliberately separate from `DbDriver` so a
 * read-only consumer can never reach a write. A writable connection is only
 * ever constructed by the `DbWrite` module, behind a per-connection unlock.
 */
export interface DbWriteDriver {
  readonly engine: DatabaseEngine;
  /**
   * Run a statement inside a read-write transaction. When `commit` is false the
   * transaction is rolled back, so the caller can preview affected rows without
   * persisting anything.
   */
  executeWrite(sql: string, commit: boolean): Promise<WriteResult>;
  close(): Promise<void>;
}

/** Identifiers we accept after resolving against the live catalog. */
const SAFE_IDENTIFIER = /^[A-Za-z0-9_$]+$/;

/** Defence in depth: a catalog-sourced identifier must still be well-formed. */
export function assertSafeIdentifier(value: string): string {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(`Unsafe identifier: ${value}`);
  }
  return value;
}

/** Clamp a caller-supplied row limit into a sane range. */
export function clampLimit(limit: number | undefined, fallback = 100): number {
  if (!Number.isFinite(limit) || limit === undefined) return fallback;
  return Math.min(Math.max(Math.trunc(limit), 1), 1000);
}

/** Clamp a caller-supplied page offset to a non-negative integer. */
export function clampOffset(offset: number | undefined): number {
  if (!Number.isFinite(offset) || offset === undefined) return 0;
  return Math.max(Math.trunc(offset), 0);
}

/**
 * Normalize user SQL before we wrap it in a row-capping subquery: trim and drop
 * a single trailing semicolon. Drivers run the result inside a read-only
 * transaction, so a write would be rejected server-side regardless.
 */
export function prepareUserQuery(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, "").trim();
  if (!trimmed) throw new Error("Query is empty.");
  return trimmed;
}

/** The leading keyword of a statement, lowercased (e.g. "select", "delete"). */
export function leadingKeyword(sql: string): string {
  return /^\s*([a-z]+)/i.exec(sql)?.[1]?.toLowerCase() ?? "";
}

/** Statements we treat as reads — routed through the read-only query path. */
const READ_KEYWORDS = new Set([
  "select",
  "show",
  "explain",
  "pragma",
  "describe",
  "desc",
]);

/** True for plain read statements; anything else is treated as a write. */
export function isReadStatement(sql: string): boolean {
  return READ_KEYWORDS.has(leadingKeyword(sql));
}

/** DDL implicitly commits on MySQL, so a rolled-back preview can't be trusted. */
const DDL_KEYWORDS = new Set([
  "create",
  "alter",
  "drop",
  "truncate",
  "rename",
  "grant",
  "revoke",
]);

/**
 * Whether a write can be safely previewed by running it in a transaction and
 * rolling back. True everywhere except MySQL DDL, which auto-commits — there a
 * "preview" would actually apply the change, so we refuse to dry-run it.
 */
export function canPreviewWrite(engine: DatabaseEngine, sql: string): boolean {
  if (engine === "mysql" && DDL_KEYWORDS.has(leadingKeyword(sql))) return false;
  return true;
}

/**
 * Query results carry no catalog metadata, so synthesize ColumnInfo from the
 * result's field names — preserving order even when zero rows come back.
 */
export function columnsFromNames(names: string[]): ColumnInfo[] {
  return names.map((name) => ({
    name,
    dataType: "",
    nullable: true,
    primaryKey: false,
  }));
}

/**
 * Drivers select `*` and return whatever the row shapes are. JSON.stringify
 * can't serialize Buffers/BigInts/Dates cleanly, so normalize to display-safe
 * primitives before they leave the core layer.
 */
export function normalizeCell(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `\\x${value.toString("hex")}`;
  if (typeof value === "object") return value; // arrays / json columns
  return value;
}

export function normalizeRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = normalizeCell(value);
  }
  return out;
}
