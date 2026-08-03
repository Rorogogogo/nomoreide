import type { Pool, PoolClient } from "pg";
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

  capabilities(): DatabaseCapabilities {
    return {
      objectKinds: ["table", "view", "materializedView", "function", "procedure", "sequence"],
      tableDetails: ["columns", "indexes", "constraints", "triggers"],
    };
  }

  async listSchemas(): Promise<DatabaseSchema[]> {
    return this.withReadOnly(async (client) => {
      const { rows } = await client.query<{ name: string }>(
        `SELECT schema_name AS name
           FROM information_schema.schemata
          WHERE schema_name <> 'information_schema'
            AND schema_name NOT LIKE 'pg_%'
          ORDER BY schema_name`,
      );
      return rows;
    });
  }

  async listObjects(
    schema: string,
    kinds?: DatabaseObjectKind[],
  ): Promise<DatabaseObject[]> {
    const allowed = new Set(kinds ?? this.capabilities().objectKinds);
    return this.withReadOnly(async (client) => {
      const objects: DatabaseObject[] = [];
      const { rows: relations } = await client.query<{
        name: string;
        relkind: "r" | "p" | "v" | "m" | "S";
        oid: string;
      }>(
        `SELECT c.relname AS name, c.relkind, c.oid::text AS oid
           FROM pg_catalog.pg_class c
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
          ORDER BY c.relname`,
        [schema],
      );
      const kindFor = (relkind: string): DatabaseObjectKind =>
        relkind === "v" ? "view" : relkind === "m" ? "materializedView" : relkind === "S" ? "sequence" : "table";
      for (const relation of relations) {
        const kind = kindFor(relation.relkind);
        if (allowed.has(kind)) {
          objects.push(objectFromIdentity({ schema, name: relation.name, kind, nativeId: relation.oid }));
        }
      }
      const routineKinds = [...allowed].filter((kind) => kind === "function" || kind === "procedure");
      if (routineKinds.length) {
        const { rows: routines } = await client.query<{
          name: string;
          prokind: "f" | "p";
          oid: string;
          arguments: string;
        }>(
          `SELECT p.proname AS name, p.prokind, p.oid::text AS oid,
                  pg_get_function_identity_arguments(p.oid) AS arguments
             FROM pg_catalog.pg_proc p
             JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')
            ORDER BY p.proname, arguments`,
          [schema],
        );
        for (const routine of routines) {
          const kind: DatabaseObjectKind = routine.prokind === "p" ? "procedure" : "function";
          if (!allowed.has(kind)) continue;
          objects.push(objectFromIdentity({
            schema,
            name: `${routine.name}(${routine.arguments})`,
            kind,
            nativeId: routine.oid,
          }));
        }
      }
      return objects;
    });
  }

  async describeObject(object: DatabaseObject): Promise<DatabaseObjectDetails> {
    const live = await this.listObjects(object.schema, [object.kind]);
    const resolved = live.find((candidate) => candidate.key === object.key);
    if (!resolved) throw new Error("Database object was not found in the live catalog.");
    return this.withReadOnly(async (client) => {
      const relationName = resolved.kind === "function" || resolved.kind === "procedure"
        ? resolved.name.slice(0, resolved.name.indexOf("("))
        : resolved.name;
      const columns = ["table", "view", "materializedView"].includes(resolved.kind)
        ? await this.columnsFor(client, resolved.schema, relationName)
        : [];
      const { rows: indexes } = await client.query<{ name: string; definition: string }>(
        `SELECT indexname AS name, indexdef AS definition
           FROM pg_catalog.pg_indexes
          WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname`,
        [resolved.schema, relationName],
      );
      const { rows: constraints } = await client.query<{ name: string; type: string; definition: string }>(
        `SELECT c.conname AS name, c.contype::text AS type,
                pg_get_constraintdef(c.oid, true) AS definition
           FROM pg_catalog.pg_constraint c
           JOIN pg_catalog.pg_class r ON r.oid = c.conrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace
          WHERE n.nspname = $1 AND r.relname = $2 ORDER BY c.conname`,
        [resolved.schema, relationName],
      );
      const { rows: triggers } = await client.query<{ name: string; definition: string }>(
        `SELECT t.tgname AS name, pg_get_triggerdef(t.oid, true) AS definition
           FROM pg_catalog.pg_trigger t
           JOIN pg_catalog.pg_class r ON r.oid = t.tgrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace
          WHERE NOT t.tgisinternal AND n.nspname = $1 AND r.relname = $2
          ORDER BY t.tgname`,
        [resolved.schema, relationName],
      );
      let definition: string | undefined;
      if ((resolved.kind === "function" || resolved.kind === "procedure") && resolved.nativeId) {
        const result = await client.query<{ definition: string }>(
          "SELECT pg_get_functiondef($1::oid) AS definition",
          [resolved.nativeId],
        );
        definition = result.rows[0]?.definition;
      } else if (resolved.kind === "view" || resolved.kind === "materializedView") {
        const result = await client.query<{ definition: string }>(
          "SELECT pg_get_viewdef($1::oid, true) AS definition",
          [resolved.nativeId],
        );
        definition = result.rows[0]?.definition;
      }
      const createScript = await this.createScriptFor(
        client,
        resolved,
        definition,
        constraints,
        triggers,
      );
      return {
        object: resolved,
        columns,
        indexes: indexes.map((index) => ({ ...index, definition: capDefinition(index.definition) ?? "", unique: /CREATE UNIQUE INDEX/i.test(index.definition) })),
        constraints: constraints.map((constraint) => ({ ...constraint, definition: capDefinition(constraint.definition) ?? "" })),
        triggers: triggers.map((trigger) => ({ ...trigger, definition: capDefinition(trigger.definition) ?? "" })),
        definition: capDefinition(definition),
        createScript: capDefinition(createScript),
      };
    });
  }

  private async createScriptFor(
    client: PoolClient,
    object: DatabaseObject,
    definition: string | undefined,
    constraints: Array<{ name: string; type: string; definition: string }>,
    triggers: Array<{ name: string; definition: string }>,
  ): Promise<string | undefined> {
    const qualifiedName = `${quoteIdentifier(object.schema)}.${quoteIdentifier(object.name)}`;
    if (object.kind === "function" || object.kind === "procedure") {
      return definition ? terminateStatement(definition) : undefined;
    }
    if (object.kind === "view" || object.kind === "materializedView") {
      if (!definition) return undefined;
      const materialized = object.kind === "materializedView" ? "MATERIALIZED " : "";
      return terminateStatement(`CREATE ${materialized}VIEW ${qualifiedName} AS\n${stripTerminator(definition)}`);
    }
    if (object.kind === "sequence") {
      const result = await client.query<{
        data_type: string;
        start_value: string;
        increment_by: string;
        min_value: string;
        max_value: string;
        cache_size: string;
        cycle: boolean;
      }>(
        `SELECT format_type(s.seqtypid, NULL) AS data_type,
                s.seqstart::text AS start_value,
                s.seqincrement::text AS increment_by,
                s.seqmin::text AS min_value,
                s.seqmax::text AS max_value,
                s.seqcache::text AS cache_size,
                s.seqcycle AS cycle
           FROM pg_catalog.pg_sequence s
          WHERE s.seqrelid = $1::oid`,
        [object.nativeId],
      );
      const sequence = result.rows[0];
      if (!sequence) return undefined;
      return terminateStatement([
        `CREATE SEQUENCE ${qualifiedName}`,
        `  AS ${sequence.data_type}`,
        `  INCREMENT BY ${sequence.increment_by}`,
        `  MINVALUE ${sequence.min_value}`,
        `  MAXVALUE ${sequence.max_value}`,
        `  START WITH ${sequence.start_value}`,
        `  CACHE ${sequence.cache_size}`,
        sequence.cycle ? "  CYCLE" : "  NO CYCLE",
      ].join("\n"));
    }
    if (object.kind !== "table" || !object.nativeId) return undefined;

    const { rows: columns } = await client.query<{
      name: string;
      data_type: string;
      default_value: string | null;
      not_null: boolean;
      identity: "" | "a" | "d";
      generated: "" | "s";
    }>(
      `SELECT a.attname AS name,
              pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
              pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_value,
              a.attnotnull AS not_null,
              a.attidentity AS identity,
              a.attgenerated AS generated
         FROM pg_catalog.pg_attribute a
         LEFT JOIN pg_catalog.pg_attrdef d
           ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [object.nativeId],
    );
    const columnLines = columns.map((column) => {
      const parts = [quoteIdentifier(column.name), column.data_type];
      if (column.generated === "s" && column.default_value) {
        parts.push(`GENERATED ALWAYS AS (${column.default_value}) STORED`);
      } else if (column.identity) {
        parts.push(
          column.identity === "a"
            ? "GENERATED ALWAYS AS IDENTITY"
            : "GENERATED BY DEFAULT AS IDENTITY",
        );
      } else if (column.default_value) {
        parts.push(`DEFAULT ${column.default_value}`);
      }
      if (column.not_null) parts.push("NOT NULL");
      return `  ${parts.join(" ")}`;
    });
    const constraintLines = constraints.map(
      (constraint) =>
        `  CONSTRAINT ${quoteIdentifier(constraint.name)} ${constraint.definition}`,
    );
    const relation = await client.query<{
      partition_key: string | null;
    }>(
      "SELECT pg_get_partkeydef($1::oid) AS partition_key",
      [object.nativeId],
    );
    const createTable = [
      `CREATE TABLE ${qualifiedName} (`,
      [...columnLines, ...constraintLines].join(",\n"),
      `)${relation.rows[0]?.partition_key ? ` PARTITION BY ${relation.rows[0].partition_key}` : ""};`,
    ].join("\n");
    const { rows: indexes } = await client.query<{ definition: string }>(
      `SELECT i.indexdef AS definition
         FROM pg_catalog.pg_indexes i
         JOIN pg_catalog.pg_class idx ON idx.relname = i.indexname
         JOIN pg_catalog.pg_namespace n ON n.oid = idx.relnamespace
        WHERE i.schemaname = $1 AND i.tablename = $2 AND n.nspname = $1
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conindid = idx.oid
          )
        ORDER BY i.indexname`,
      [object.schema, object.name],
    );
    return [
      createTable,
      ...indexes.map((index) => terminateStatement(index.definition)),
      ...triggers.map((trigger) => terminateStatement(trigger.definition)),
    ].join("\n\n");
  }

  async sampleRows(table: TableRef, limit: number, offset?: number): Promise<RowSample> {
    const schema = table.schema ?? "public";
    const name = table.name;
    const max = clampLimit(limit);
    const skip = clampOffset(offset);
    return this.withReadOnly(async (client) => {
      const columns = await this.columnsFor(client, schema, name);
      const { rows } = await client.query(
        `SELECT * FROM ${quoteIdentifier(schema)}.${quoteIdentifier(name)} LIMIT $1 OFFSET $2`,
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

  async deleteRows(options: DeleteRowsOptions): Promise<WriteResult> {
    if (!this.writable) throw new Error("This connection is read-only.");
    const table = options.table.schema
      ? `${quoteIdentifier(options.table.schema)}.${quoteIdentifier(options.table.name)}`
      : quoteIdentifier(options.table.name);
    const values = options.tuples.flatMap((tuple) =>
      options.primaryKeys.map((column) => tuple[column]),
    );
    let parameter = 0;
    const predicate = options.tuples
      .map(
        () =>
          `(${options.primaryKeys
            .map((column) => `${quoteIdentifier(column)} = $${++parameter}`)
            .join(" AND ")})`,
      )
      .join(" OR ");

    const pool = await this.pool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(`DELETE FROM ${table} WHERE ${predicate}`, values);
      const affectedRows = result.rowCount ?? 0;
      assertExpectedDeleteCount(options, affectedRows);
      await client.query(options.commit ? "COMMIT" : "ROLLBACK");
      return { affectedRows, rows: [], columns: [], committed: options.commit };
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

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function stripTerminator(value: string): string {
  return value.trim().replace(/;+$/, "");
}

function terminateStatement(value: string): string {
  return `${stripTerminator(value)};`;
}
