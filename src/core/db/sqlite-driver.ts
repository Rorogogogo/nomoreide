import type { DatabaseSync } from "node:sqlite";
import type { DatabaseEngine } from "../types.js";
import {
  assertSafeIdentifier,
  clampLimit,
  clampOffset,
  normalizeRow,
  type ColumnInfo,
  type DbDriver,
  type RowSample,
  type TableRef,
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
export class SqliteDriver implements DbDriver {
  readonly engine: DatabaseEngine = "sqlite";
  private dbPromise: Promise<DatabaseSync> | null = null;

  constructor(private readonly file: string) {}

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
        return new DatabaseSync(this.file, { readOnly: true });
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

  async close(): Promise<void> {
    if (this.dbPromise) {
      const db = await this.dbPromise;
      db.close();
      this.dbPromise = null;
    }
  }
}
