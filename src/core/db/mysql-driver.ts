import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import type { DatabaseEngine } from "../types.js";
import {
  assertSafeIdentifier,
  clampLimit,
  clampOffset,
  columnsFromNames,
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

/**
 * MySQL / MariaDB driver. Read operations run in a `START TRANSACTION READ
 * ONLY` block, then roll back. A driver constructed with `{ writable: true }`
 * (only the DbWrite module does this) exposes the guarded `executeWrite` path.
 */
export class MysqlDriver implements DbDriver, DbWriteDriver {
  readonly engine: DatabaseEngine = "mysql";
  private poolPromise: Promise<Pool> | null = null;
  private readonly writable: boolean;

  constructor(private readonly url: string, options: { writable?: boolean } = {}) {
    this.writable = options.writable ?? false;
  }

  private async pool(): Promise<Pool> {
    if (!this.poolPromise) {
      this.poolPromise = (async () => {
        const mysql = await import("mysql2/promise");
        return mysql.createPool({
          uri: this.url,
          connectionLimit: 4,
          connectTimeout: 8000,
          // Surface BIGINT/DECIMAL as strings so values survive JSON intact.
          decimalNumbers: false,
          supportBigNumbers: true,
          bigNumberStrings: true,
        });
      })();
    }
    return this.poolPromise;
  }

  private async withReadOnly<T>(
    fn: (conn: PoolConnection) => Promise<T>,
  ): Promise<T> {
    const pool = await this.pool();
    const conn = await pool.getConnection();
    try {
      await conn.query("START TRANSACTION READ ONLY");
      const result = await fn(conn);
      await conn.query("COMMIT");
      return result;
    } catch (error) {
      await conn.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async testConnection(): Promise<void> {
    await this.withReadOnly((conn) => conn.query("SELECT 1"));
  }

  async listTables(): Promise<TableRef[]> {
    return this.withReadOnly(async (conn) => {
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT table_name
           FROM information_schema.tables
          WHERE table_schema = DATABASE()
          ORDER BY table_name`,
      );
      return rows.map((row) => {
        const name = String(row.table_name ?? row.TABLE_NAME);
        return { name, qualifiedName: name };
      });
    });
  }

  async sampleRows(table: TableRef, limit: number, offset?: number): Promise<RowSample> {
    const name = assertSafeIdentifier(table.name);
    const max = clampLimit(limit);
    const skip = clampOffset(offset);
    return this.withReadOnly(async (conn) => {
      const columns = await this.columnsFor(conn, name);
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT * FROM \`${name}\` LIMIT ? OFFSET ?`,
        [max, skip],
      );
      return {
        columns,
        rows: rows.map((row) => normalizeRow(row as Record<string, unknown>)),
        rowCount: rows.length,
        limit: max,
        offset: skip,
      };
    });
  }

  async runQuery(sql: string, maxRows: number): Promise<QueryResult> {
    const statement = prepareUserQuery(sql);
    const cap = clampLimit(maxRows);
    return this.withReadOnly(async (conn) => {
      // Wrap in a derived table so the row cap applies without parsing the SQL;
      // START TRANSACTION READ ONLY rejects any write regardless.
      const [rows, fields] = await conn.query<RowDataPacket[]>(
        `SELECT * FROM (${statement}) AS _nmi_q LIMIT ?`,
        [cap + 1],
      );
      const truncated = rows.length > cap;
      const capped = truncated ? rows.slice(0, cap) : rows;
      const names = (fields ?? []).map((field) => field.name);
      return {
        columns: columnsFromNames(names),
        rows: capped.map((row) => normalizeRow(row as Record<string, unknown>)),
        rowCount: capped.length,
        truncated,
      };
    });
  }

  async executeWrite(sql: string, commit: boolean): Promise<WriteResult> {
    if (!this.writable) throw new Error("This connection is read-only.");
    const statement = prepareUserQuery(sql);
    const pool = await this.pool();
    const conn = await pool.getConnection();
    try {
      await conn.query("START TRANSACTION");
      const [result, fields] = await conn.query(statement);
      await conn.query(commit ? "COMMIT" : "ROLLBACK");
      // A SELECT yields a row array; DML yields a ResultSetHeader.
      if (Array.isArray(result)) {
        const rows = (result as RowDataPacket[]).map((row) =>
          normalizeRow(row as Record<string, unknown>),
        );
        return {
          affectedRows: rows.length,
          rows,
          columns: columnsFromNames((fields ?? []).map((field) => field.name)),
          committed: commit,
        };
      }
      return {
        affectedRows: (result as ResultSetHeader).affectedRows ?? 0,
        rows: [],
        columns: [],
        committed: commit,
      };
    } catch (error) {
      await conn.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  private async columnsFor(
    conn: PoolConnection,
    name: string,
  ): Promise<ColumnInfo[]> {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT column_name, data_type, is_nullable, column_key
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = ?
        ORDER BY ordinal_position`,
      [name],
    );
    return rows.map((row) => ({
      name: String(row.column_name ?? row.COLUMN_NAME),
      dataType: String(row.data_type ?? row.DATA_TYPE),
      nullable: String(row.is_nullable ?? row.IS_NULLABLE) === "YES",
      primaryKey: String(row.column_key ?? row.COLUMN_KEY) === "PRI",
    }));
  }

  async close(): Promise<void> {
    if (this.poolPromise) {
      const pool = await this.poolPromise;
      await pool.end();
      this.poolPromise = null;
    }
  }
}
