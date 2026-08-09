import type { DatabaseEngine } from "../types.js";
import type {
  DatabaseCapabilities,
  DatabaseObject,
  DatabaseObjectDetails,
  DatabaseObjectKind,
  DatabaseSchema,
} from "./catalog.js";

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

export type RowFilterOperator =
  | "eq"
  | "neq"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "isNull"
  | "isNotNull";

export interface RowFilter {
  column: string;
  operator: RowFilterOperator;
  value?: string;
}

export interface RowSort {
  column: string;
  direction: "asc" | "desc";
}

export interface RowBrowseQuery {
  filters?: RowFilter[];
  sort?: RowSort;
}

export interface StreamRowsOptions {
  batchSize?: number;
  signal?: AbortSignal;
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
  capabilities(): DatabaseCapabilities;
  listSchemas(): Promise<DatabaseSchema[]>;
  listObjects(schema: string, kinds?: DatabaseObjectKind[]): Promise<DatabaseObject[]>;
  describeObject(object: DatabaseObject): Promise<DatabaseObjectDetails>;
  sampleRows(
    table: TableRef,
    limit: number,
    offset?: number,
    query?: RowBrowseQuery,
  ): Promise<RowSample>;
  /** Stream a stable read-only snapshot in bounded batches. */
  streamRows(
    table: TableRef,
    columns: ColumnInfo[],
    options?: StreamRowsOptions,
  ): AsyncIterable<Array<Record<string, unknown>>>;
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
export type PrimaryKeyValue = string | number | boolean;
export type PrimaryKeyTuple = Record<string, PrimaryKeyValue>;

export interface DeleteRowsOptions {
  table: TableRef;
  primaryKeys: string[];
  tuples: PrimaryKeyTuple[];
  commit: boolean;
  /** When supplied for a commit, a mismatch must roll the transaction back. */
  expectedAffectedRows?: number;
}

export interface DbWriteDriver extends DbDriver {
  /**
   * Run a statement inside a read-write transaction. When `commit` is false the
   * transaction is rolled back, so the caller can preview affected rows without
   * persisting anything.
   */
  executeWrite(sql: string, commit: boolean): Promise<WriteResult>;
  /** Delete exact primary-key tuples using bound values in one transaction. */
  deleteRows(options: DeleteRowsOptions): Promise<WriteResult>;
}

/** Throw inside the active transaction when a guarded commit changed unexpectedly. */
export function assertExpectedDeleteCount(
  options: DeleteRowsOptions,
  affectedRows: number,
): void {
  if (
    options.commit &&
    options.expectedAffectedRows !== undefined &&
    affectedRows !== options.expectedAffectedRows
  ) {
    throw new Error(
      `Delete affected ${affectedRows} rows; expected ${options.expectedAffectedRows}. The transaction was rolled back.`,
    );
  }
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
  return Math.min(Math.max(Math.trunc(limit), 1), 5_000);
}

/** Clamp a caller-supplied page offset to a non-negative integer. */
export function clampOffset(offset: number | undefined): number {
  if (!Number.isFinite(offset) || offset === undefined) return 0;
  return Math.max(Math.trunc(offset), 0);
}

const ROW_FILTER_OPERATORS = new Set<RowFilterOperator>([
  "eq",
  "neq",
  "contains",
  "startsWith",
  "endsWith",
  "gt",
  "gte",
  "lt",
  "lte",
  "isNull",
  "isNotNull",
]);

/** Validate browser query controls against columns read from the live catalog. */
export function normalizeRowBrowseQuery(
  columns: ColumnInfo[],
  query: RowBrowseQuery | undefined,
): RowBrowseQuery {
  const columnNames = new Set(columns.map((column) => column.name));
  const filters = query?.filters ?? [];
  if (filters.length > 8) throw new Error("A maximum of 8 row filters is supported.");
  const normalizedFilters = filters.map((filter) => {
    if (!columnNames.has(filter.column)) {
      throw new Error(`Unknown filter column: ${filter.column}`);
    }
    if (!ROW_FILTER_OPERATORS.has(filter.operator)) {
      throw new Error(`Unsupported row filter operator: ${filter.operator}`);
    }
    const unary = filter.operator === "isNull" || filter.operator === "isNotNull";
    const value = unary ? undefined : filter.value;
    if (!unary && value === undefined) throw new Error("This row filter requires a value.");
    if (value !== undefined && value.length > 2_000) {
      throw new Error("Row filter values must be 2,000 characters or fewer.");
    }
    return { column: filter.column, operator: filter.operator, value };
  });
  const sort = query?.sort;
  if (sort && !columnNames.has(sort.column)) {
    throw new Error(`Unknown sort column: ${sort.column}`);
  }
  if (sort && sort.direction !== "asc" && sort.direction !== "desc") {
    throw new Error("Sort direction must be asc or desc.");
  }
  return { filters: normalizedFilters, sort };
}

/** Build a parameterized WHERE/ORDER BY fragment shared by all Node drivers. */
export function buildRowBrowseClauses(
  columns: ColumnInfo[],
  query: RowBrowseQuery | undefined,
  quoteIdentifier: (value: string) => string,
  placeholder: (index: number) => string,
): { whereSql: string; orderBySql: string; values: string[] } {
  const normalized = normalizeRowBrowseQuery(columns, query);
  const values: string[] = [];
  const filters = (normalized.filters ?? []).map((filter) => {
    const column = quoteIdentifier(filter.column);
    if (filter.operator === "isNull") return `${column} IS NULL`;
    if (filter.operator === "isNotNull") return `${column} IS NOT NULL`;
    let value = filter.value ?? "";
    let operator = "=";
    if (filter.operator === "neq") operator = "<>";
    else if (filter.operator === "gt") operator = ">";
    else if (filter.operator === "gte") operator = ">=";
    else if (filter.operator === "lt") operator = "<";
    else if (filter.operator === "lte") operator = "<=";
    else if (["contains", "startsWith", "endsWith"].includes(filter.operator)) {
      value = value.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");
      if (filter.operator !== "startsWith") value = `%${value}`;
      if (filter.operator !== "endsWith") value = `${value}%`;
      operator = "LIKE";
    }
    values.push(value);
    const likeEscape = operator === "LIKE" ? " ESCAPE '!'" : "";
    return `${column} ${operator} ${placeholder(values.length)}${likeEscape}`;
  });
  const orderColumns: RowSort[] = [];
  if (normalized.sort) orderColumns.push(normalized.sort);
  for (const column of columns.filter((candidate) => candidate.primaryKey)) {
    if (column.name !== normalized.sort?.column) {
      orderColumns.push({ column: column.name, direction: "asc" });
    }
  }
  return {
    whereSql: filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : "",
    orderBySql: orderColumns.length > 0
      ? ` ORDER BY ${orderColumns.map((sort) => `${quoteIdentifier(sort.column)} ${sort.direction.toUpperCase()}`).join(", ")}`
      : "",
    values,
  };
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
