import type { Pool, PoolClient } from "pg";
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
 * Postgres driver. Every statement runs inside a `READ ONLY` transaction, so
 * even a mistaken write would be rejected by the server.
 */
export class PostgresDriver implements DbDriver {
  readonly engine: DatabaseEngine = "postgres";
  private poolPromise: Promise<Pool> | null = null;

  constructor(private readonly url: string) {}

  private async pool(): Promise<Pool> {
    if (!this.poolPromise) {
      this.poolPromise = (async () => {
        const { default: pg } = await import("pg");
        return new pg.Pool({
          connectionString: this.url,
          max: 4,
          connectionTimeoutMillis: 8000,
          // Belt-and-suspenders: every session defaults to read-only.
          options: "-c default_transaction_read_only=on",
        });
      })();
    }
    return this.poolPromise;
  }

  private async withReadOnly<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const pool = await this.pool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async testConnection(): Promise<void> {
    await this.withReadOnly((client) => client.query("SELECT 1"));
  }

  async listTables(): Promise<TableRef[]> {
    return this.withReadOnly(async (client) => {
      const { rows } = await client.query<{
        table_schema: string;
        table_name: string;
      }>(
        `SELECT table_schema, table_name
           FROM information_schema.tables
          WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
            AND table_type IN ('BASE TABLE', 'VIEW')
          ORDER BY table_schema, table_name`,
      );
      return rows.map((row) => ({
        schema: row.table_schema,
        name: row.table_name,
        qualifiedName: `${row.table_schema}.${row.table_name}`,
      }));
    });
  }

  async sampleRows(table: TableRef, limit: number): Promise<RowSample> {
    const schema = assertSafeIdentifier(table.schema ?? "public");
    const name = assertSafeIdentifier(table.name);
    const max = clampLimit(limit);
    return this.withReadOnly(async (client) => {
      const columns = await this.columnsFor(client, schema, name);
      const { rows } = await client.query(
        `SELECT * FROM "${schema}"."${name}" LIMIT $1`,
        [max],
      );
      return {
        columns,
        rows: rows.map((row: Record<string, unknown>) => normalizeRow(row)),
        rowCount: rows.length,
      };
    });
  }

  private async columnsFor(
    client: PoolClient,
    schema: string,
    name: string,
  ): Promise<ColumnInfo[]> {
    const { rows } = await client.query<{
      column_name: string;
      data_type: string;
      is_nullable: "YES" | "NO";
      is_primary: boolean;
    }>(
      `SELECT c.column_name,
              c.data_type,
              c.is_nullable,
              COALESCE(pk.is_primary, false) AS is_primary
         FROM information_schema.columns c
         LEFT JOIN (
           SELECT kcu.column_name, true AS is_primary
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
               ON kcu.constraint_name = tc.constraint_name
              AND kcu.table_schema = tc.table_schema
            WHERE tc.constraint_type = 'PRIMARY KEY'
              AND tc.table_schema = $1
              AND tc.table_name = $2
         ) pk ON pk.column_name = c.column_name
        WHERE c.table_schema = $1 AND c.table_name = $2
        ORDER BY c.ordinal_position`,
      [schema, name],
    );
    return rows.map((row) => ({
      name: row.column_name,
      dataType: row.data_type,
      nullable: row.is_nullable === "YES",
      primaryKey: row.is_primary,
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
