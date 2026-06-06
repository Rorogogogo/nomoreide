import type { DatabaseSync } from "node:sqlite";
import type { DatabaseEngine } from "../types.js";
import {
  assertSafeIdentifier,
  clampLimit,
  clampOffset,
  columnsFromNames,
  isReadStatement,
  normalizeRow,
  prepareUserQuery,
  type ColumnInfo,
  type DbDriver,
  type DbWriteDriver,
  type QueryResult,
  type RowSample,
  type TableRef,
  type WriteResult,
} from "./driver.js";

interface PragmaColumn {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

/**
 * SQLite driver backed by Node's built-in `node:sqlite`. The file is opened
 * read-only, so the connection itself cannot mutate the database.
 */
export class SqliteDriver implements DbDriver, DbWriteDriver {
  readonly engine: DatabaseEngine = "sqlite";
  private dbPromise: Promise<DatabaseSync> | null = null;
  private readonly writable: boolean;

  constructor(private readonly file: string, options: { writable?: boolean } = {}) {
    this.writable = options.writable ?? false;
  }

  private async db(): Promise<DatabaseSync> {
    if (!this.dbPromise) {
      this.dbPromise = (async () => {
        let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
        try {
          ({ DatabaseSync } = await import("node:sqlite"));
        } catch {
          throw new Error(
            `SQLite browsing requires Node >=22.5 (uses the built-in node:sqlite module); you're on ${process.version}. Upgrade Node, or use a Postgres/MySQL connection instead.`,
          );
        }
        // Read-only handles can't mutate the file at all; writable handles back
        // the guarded executeWrite path only.
        return new DatabaseSync(this.file, { readOnly: !this.writable });
      })();
    }
    return this.dbPromise;
  }

  async testConnection(): Promise<void> {
    const db = await this.db();
    db.prepare("SELECT 1").get();
  }

  async listTables(): Promise<TableRef[]> {
    const db = await this.db();
    const rows = db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
          ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    return rows.map((row) => ({ name: row.name, qualifiedName: row.name }));
  }

  async sampleRows(table: TableRef, limit: number, offset?: number): Promise<RowSample> {
    const name = assertSafeIdentifier(table.name);
    const max = clampLimit(limit);
    const skip = clampOffset(offset);
    const db = await this.db();
    const columns = (
      db.prepare(`PRAGMA table_info("${name}")`).all() as unknown as PragmaColumn[]
    ).map<ColumnInfo>((col) => ({
      name: col.name,
      dataType: col.type || "",
      nullable: col.notnull === 0,
      primaryKey: col.pk > 0,
    }));
    const rows = db
      .prepare(`SELECT * FROM "${name}" LIMIT ? OFFSET ?`)
      .all(max, skip) as Array<Record<string, unknown>>;
    return {
      columns,
      rows: rows.map((row) => normalizeRow(row)),
      rowCount: rows.length,
      limit: max,
      offset: skip,
    };
  }

  async runQuery(sql: string, maxRows: number): Promise<QueryResult> {
    const statement = prepareUserQuery(sql);
    const cap = clampLimit(maxRows);
    const db = await this.db();
    // The connection is opened read-only, so a write statement throws here.
    const rows = db
      .prepare(`SELECT * FROM (${statement}) LIMIT ?`)
      .all(cap + 1) as Array<Record<string, unknown>>;
    const truncated = rows.length > cap;
    const capped = truncated ? rows.slice(0, cap) : rows;
    // node:sqlite exposes columns only via row keys; the wrap guarantees at
    // least one synthesized column name per result field when rows exist.
    const names = capped.length > 0 ? Object.keys(capped[0]) : [];
    return {
      columns: columnsFromNames(names),
      rows: capped.map((row) => normalizeRow(row)),
      rowCount: capped.length,
      truncated,
    };
  }

  async executeWrite(sql: string, commit: boolean): Promise<WriteResult> {
    if (!this.writable) throw new Error("This connection is read-only.");
    const statement = prepareUserQuery(sql);
    const db = await this.db();
    db.exec("BEGIN");
    try {
      // SELECT / RETURNING produce rows; other statements report `changes`.
      const returnsRows =
        isReadStatement(statement) || /\breturning\b/i.test(statement);
      let result: WriteResult;
      if (returnsRows) {
        const rows = db.prepare(statement).all() as Array<Record<string, unknown>>;
        const names = rows.length > 0 ? Object.keys(rows[0]) : [];
        result = {
          affectedRows: rows.length,
          rows: rows.map((row) => normalizeRow(row)),
          columns: columnsFromNames(names),
          committed: commit,
        };
      } else {
        const info = db.prepare(statement).run();
        result = {
          affectedRows: Number(info.changes),
          rows: [],
          columns: [],
          committed: commit,
        };
      }
      db.exec(commit ? "COMMIT" : "ROLLBACK");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.dbPromise) {
      const db = await this.dbPromise;
      db.close();
      this.dbPromise = null;
    }
  }
}
