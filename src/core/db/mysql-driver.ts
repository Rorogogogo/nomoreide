import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import type { DatabaseEngine } from "../types.js";
import {
  capDefinition,
  objectFromIdentity,
  type DatabaseCapabilities,
  type DatabaseObject,
  type DatabaseObjectDetails,
  type DatabaseObjectKind,
  type DatabaseSchema,
} from "./catalog.js";
import {
  assertExpectedDeleteCount,
  clampLimit,
  clampOffset,
  columnsFromNames,
  normalizeRow,
  prepareUserQuery,
  type ColumnInfo,
  type DeleteRowsOptions,
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

  capabilities(): DatabaseCapabilities {
    return {
      objectKinds: ["table", "view", "function", "procedure"],
      tableDetails: ["columns", "indexes", "constraints", "triggers"],
    };
  }

  async listSchemas(): Promise<DatabaseSchema[]> {
    return this.withReadOnly(async (conn) => {
      const [rows] = await conn.query<RowDataPacket[]>("SELECT DATABASE() AS name");
      const name = String(rows[0]?.name ?? "");
      return name ? [{ name }] : [];
    });
  }

  async listObjects(
    schema: string,
    kinds?: DatabaseObjectKind[],
  ): Promise<DatabaseObject[]> {
    const allowed = new Set(kinds ?? this.capabilities().objectKinds);
    return this.withReadOnly(async (conn) => {
      const objects: DatabaseObject[] = [];
      const [tables] = await conn.query<RowDataPacket[]>(
        `SELECT table_name, table_type
           FROM information_schema.tables
          WHERE table_schema = ? ORDER BY table_name`,
        [schema],
      );
      for (const table of tables) {
        const kind: DatabaseObjectKind = String(table.table_type ?? table.TABLE_TYPE) === "VIEW" ? "view" : "table";
        if (allowed.has(kind)) {
          objects.push(objectFromIdentity({ schema, name: String(table.table_name ?? table.TABLE_NAME), kind }));
        }
      }
      if (allowed.has("function") || allowed.has("procedure")) {
        const [routines] = await conn.query<RowDataPacket[]>(
          `SELECT routine_name, routine_type
             FROM information_schema.routines
            WHERE routine_schema = ? ORDER BY routine_name`,
          [schema],
        );
        for (const routine of routines) {
          const kind: DatabaseObjectKind = String(routine.routine_type ?? routine.ROUTINE_TYPE) === "PROCEDURE" ? "procedure" : "function";
          if (allowed.has(kind)) {
            objects.push(objectFromIdentity({ schema, name: String(routine.routine_name ?? routine.ROUTINE_NAME), kind }));
          }
        }
      }
      return objects;
    });
  }

  async describeObject(object: DatabaseObject): Promise<DatabaseObjectDetails> {
    const live = await this.listObjects(object.schema, [object.kind]);
    const resolved = live.find((candidate) => candidate.key === object.key);
    if (!resolved) throw new Error("Database object was not found in the live catalog.");
    return this.withReadOnly(async (conn) => {
      const columns = ["table", "view"].includes(resolved.kind)
        ? await this.columnsFor(conn, resolved.name, resolved.schema)
        : [];
      const [indexRows] = await conn.query<RowDataPacket[]>(
        `SELECT index_name, non_unique,
                GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns
           FROM information_schema.statistics
          WHERE table_schema = ? AND table_name = ?
          GROUP BY index_name, non_unique ORDER BY index_name`,
        [resolved.schema, resolved.name],
      );
      const indexes = indexRows.map((row) => ({
        name: String(row.index_name ?? row.INDEX_NAME),
        unique: Number(row.non_unique ?? row.NON_UNIQUE) === 0,
        definition: capDefinition(`(${String(row.columns ?? row.COLUMNS ?? "")})`) ?? "",
      }));
      const [constraintRows] = await conn.query<RowDataPacket[]>(
        `SELECT constraint_name, constraint_type
           FROM information_schema.table_constraints
          WHERE table_schema = ? AND table_name = ? ORDER BY constraint_name`,
        [resolved.schema, resolved.name],
      );
      const constraints = constraintRows.map((row) => ({
        name: String(row.constraint_name ?? row.CONSTRAINT_NAME),
        type: String(row.constraint_type ?? row.CONSTRAINT_TYPE),
        definition: String(row.constraint_type ?? row.CONSTRAINT_TYPE),
      }));
      const [triggerRows] = await conn.query<RowDataPacket[]>(
        `SELECT trigger_name, action_statement
           FROM information_schema.triggers
          WHERE trigger_schema = ? AND event_object_table = ? ORDER BY trigger_name`,
        [resolved.schema, resolved.name],
      );
      const triggers = triggerRows.map((row) => ({
        name: String(row.trigger_name ?? row.TRIGGER_NAME),
        definition: capDefinition(String(row.action_statement ?? row.ACTION_STATEMENT ?? "")) ?? "",
      }));
      let definition: string | undefined;
      if (resolved.kind === "view") {
        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT view_definition AS definition FROM information_schema.views
            WHERE table_schema = ? AND table_name = ?`,
          [resolved.schema, resolved.name],
        );
        definition = String(rows[0]?.definition ?? "") || undefined;
      } else if (resolved.kind === "function" || resolved.kind === "procedure") {
        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT routine_definition AS definition FROM information_schema.routines
            WHERE routine_schema = ? AND routine_name = ? AND routine_type = ?`,
          [resolved.schema, resolved.name, resolved.kind === "procedure" ? "PROCEDURE" : "FUNCTION"],
        );
        definition = String(rows[0]?.definition ?? "") || undefined;
      }
      return {
        object: resolved,
        columns,
        indexes,
        constraints,
        triggers,
        definition: capDefinition(definition),
        createScript: capDefinition(await this.createScriptFor(conn, resolved)),
      };
    });
  }

  private async createScriptFor(
    conn: PoolConnection,
    object: DatabaseObject,
  ): Promise<string | undefined> {
    const qualifiedName = `${quoteIdentifier(object.schema)}.${quoteIdentifier(object.name)}`;
    const objectType = object.kind === "procedure"
      ? "PROCEDURE"
      : object.kind === "function"
        ? "FUNCTION"
        : object.kind === "view"
          ? "VIEW"
          : "TABLE";
    try {
      const [rows] = await conn.query<RowDataPacket[]>(
        `SHOW CREATE ${objectType} ${qualifiedName}`,
      );
      const row = rows[0];
      if (!row) return undefined;
      const entry = Object.entries(row).find(([key]) =>
        key.toLowerCase().startsWith("create ")
      );
      return entry ? terminateStatement(String(entry[1])) : undefined;
    } catch {
      // SHOW CREATE can require privileges beyond catalog inspection. Keep
      // object details useful even when that optional privilege is absent.
      return undefined;
    }
  }

  async sampleRows(table: TableRef, limit: number, offset?: number): Promise<RowSample> {
    const name = table.name;
    const qualifiedName = table.schema
      ? `${quoteIdentifier(table.schema)}.${quoteIdentifier(name)}`
      : quoteIdentifier(name);
    const max = clampLimit(limit);
    const skip = clampOffset(offset);
    return this.withReadOnly(async (conn) => {
      const columns = await this.columnsFor(conn, name, table.schema);
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT * FROM ${qualifiedName} LIMIT ? OFFSET ?`,
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

  async deleteRows(options: DeleteRowsOptions): Promise<WriteResult> {
    if (!this.writable) throw new Error("This connection is read-only.");
    const table = options.table.schema
      ? `${quoteIdentifier(options.table.schema)}.${quoteIdentifier(options.table.name)}`
      : quoteIdentifier(options.table.name);
    const predicate = options.tuples
      .map(
        () =>
          `(${options.primaryKeys
            .map((column) => `${quoteIdentifier(column)} = ?`)
            .join(" AND ")})`,
      )
      .join(" OR ");
    const values = options.tuples.flatMap((tuple) =>
      options.primaryKeys.map((column) => tuple[column]),
    );

    const pool = await this.pool();
    const conn = await pool.getConnection();
    try {
      await conn.query("START TRANSACTION");
      const [result] = await conn.query<ResultSetHeader>(
        `DELETE FROM ${table} WHERE ${predicate}`,
        values,
      );
      const affectedRows = result.affectedRows ?? 0;
      assertExpectedDeleteCount(options, affectedRows);
      await conn.query(options.commit ? "COMMIT" : "ROLLBACK");
      return { affectedRows, rows: [], columns: [], committed: options.commit };
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
    schema?: string,
  ): Promise<ColumnInfo[]> {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT column_name, data_type, is_nullable, column_key
         FROM information_schema.columns
        WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ?
        ORDER BY ordinal_position`,
      [schema ?? null, name],
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

function quoteIdentifier(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}

function terminateStatement(value: string): string {
  const statement = value.trim();
  return statement.endsWith(";") ? statement : `${statement};`;
}
