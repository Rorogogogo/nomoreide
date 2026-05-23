import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import type { DatabaseEngine } from "../types.js";
import {
  assertSafeIdentifier,
  clampLimit,
  normalizeRow,
  type ColumnInfo,
  type DbDriver,
  type RowSample,
  type TableRef,
} from "./driver.js";

/**
 * MySQL / MariaDB driver. Each operation runs in a `START TRANSACTION READ
 * ONLY` block on a pooled connection, then rolls back.
 */
export class MysqlDriver implements DbDriver {
  readonly engine: DatabaseEngine = "mysql";
  private poolPromise: Promise<Pool> | null = null;

  constructor(private readonly url: string) {}

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

  async sampleRows(table: TableRef, limit: number): Promise<RowSample> {
    const name = assertSafeIdentifier(table.name);
    const max = clampLimit(limit);
    return this.withReadOnly(async (conn) => {
      const columns = await this.columnsFor(conn, name);
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT * FROM \`${name}\` LIMIT ?`,
        [max],
      );
      return {
        columns,
        rows: rows.map((row) => normalizeRow(row as Record<string, unknown>)),
        rowCount: rows.length,
      };
    });
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
