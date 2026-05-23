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
}

/**
 * Read-only access to a single database. Implementations enforce read-only at
 * the connection/transaction level — there is no raw-SQL passthrough.
 */
export interface DbDriver {
  readonly engine: DatabaseEngine;
  /** Throws if the connection cannot be established. */
  testConnection(): Promise<void>;
  listTables(): Promise<TableRef[]>;
  sampleRows(table: TableRef, limit: number): Promise<RowSample>;
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
