import type { Pool, PoolClient } from "pg";
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
 * Postgres driver. By default every statement runs inside a `READ ONLY`
 * transaction so a mistaken write is rejected by the server. A driver
 * constructed with `{ writable: true }` (only the DbWrite module does this)
 * opens a read-write pool for the guarded `executeWrite` path.
 */
export class PostgresDriver implements DbDriver, DbWriteDriver {
  readonly engine: DatabaseEngine = "postgres";
  private poolPromise: Promise<Pool> | null = null;
  private readonly writable: boolean;

  constructor(private readonly url: string, options: { writable?: boolean } = {}) {
    this.writable = options.writable ?? false;
  }

  private async pool(): Promise<Pool> {
    if (!this.poolPromise) {
      this.poolPromise = (async () => {
        const { default: pg } = await import("pg");
        return new pg.Pool({
          connectionString: this.url,
          max: 4,
          connectionTimeoutMillis: 8000,
          // Belt-and-suspenders: read-only pools default every session to
          // read-only; writable pools omit it so executeWrite can persist.
          options: this.writable ? undefined : "-c default_transaction_read_only=on",
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

  async sampleRows(table: TableRef, limit: number, offset?: number): Promise<RowSample> {
    const schema = assertSafeIdentifier(table.schema ?? "public");
    const name = assertSafeIdentifier(table.name);
    const max = clampLimit(limit);
    const skip = clampOffset(offset);
    return this.withReadOnly(async (client) => {
      const columns = await this.columnsFor(client, schema, name);
      const { rows } = await client.query(
        `SELECT * FROM "${schema}"."${name}" LIMIT $1 OFFSET $2`,
        [max, skip],
      );
      return {
        columns,
        rows: rows.map((row: Record<string, unknown>) => normalizeRow(row)),
        rowCount: rows.length,
        limit: max,
        offset: skip,
      };
    });
  }

  async runQuery(sql: string, maxRows: number): Promise<QueryResult> {
    const statement = prepareUserQuery(sql);
    const cap = clampLimit(maxRows);
    return this.withReadOnly(async (client) => {
      // Wrap in a subquery so we can bound the result set without parsing the
      // user's SQL; the READ ONLY transaction blocks any write regardless.
      const result = await client.query(
        `SELECT * FROM (${statement}) AS _nmi_q LIMIT $1`,
        [cap + 1],
      );
      const truncated = result.rows.length > cap;
      const rows = (truncated ? result.rows.slice(0, cap) : result.rows).map(
        (row: Record<string, unknown>) => normalizeRow(row),
      );
      return {
        columns: columnsFromNames(result.fields.map((field) => field.name)),
        rows,
        rowCount: rows.length,
        truncated,
      };
    });
  }

  async executeWrite(sql: string, commit: boolean): Promise<WriteResult> {
    if (!this.writable) throw new Error("This connection is read-only.");
    const statement = prepareUserQuery(sql);
    const pool = await this.pool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(statement);
      // Preview runs roll back so nothing persists; the caller sees the count.
      await client.query(commit ? "COMMIT" : "ROLLBACK");
      const rows = (result.rows ?? []).map((row: Record<string, unknown>) =>
        normalizeRow(row),
      );
      return {
        affectedRows: result.rowCount ?? rows.length,
        rows,
        columns: columnsFromNames((result.fields ?? []).map((field) => field.name)),
        committed: commit,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
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
