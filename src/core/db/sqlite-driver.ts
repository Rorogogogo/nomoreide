import type { DatabaseSync } from "node:sqlite";
import type { DatabaseEngine } from "../types.js";
import {
  capDefinition,
  objectFromIdentity,
  type DatabaseCapabilities,
  type DatabaseConstraint,
  type DatabaseIndex,
  type DatabaseObject,
  type DatabaseObjectDetails,
  type DatabaseObjectKind,
  type DatabaseSchema,
  type DatabaseTrigger,
} from "./catalog.js";
import {
  assertExpectedDeleteCount,
  buildRowBrowseClauses,
  clampLimit,
  clampOffset,
  columnsFromNames,
  isReadStatement,
  normalizeRow,
  prepareUserQuery,
  type ColumnInfo,
  type DeleteRowsOptions,
  type DbDriver,
  type DbWriteDriver,
  type QueryResult,
  type RowBrowseQuery,
  type RowSample,
  type StreamRowsOptions,
  type TableRef,
  type WriteResult,
} from "./driver.js";

interface PragmaColumn {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
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

  private async openDatabase(readOnly = !this.writable): Promise<DatabaseSync> {
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
    return new DatabaseSync(this.file, { readOnly });
  }

  private async db(): Promise<DatabaseSync> {
    if (!this.dbPromise) this.dbPromise = this.openDatabase();
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

  capabilities(): DatabaseCapabilities {
    return {
      objectKinds: ["table", "view"],
      tableDetails: ["columns", "indexes", "constraints", "triggers"],
    };
  }

  async listSchemas(): Promise<DatabaseSchema[]> {
    await this.testConnection();
    return [{ name: "main" }];
  }

  async listObjects(
    schema: string,
    kinds?: DatabaseObjectKind[],
  ): Promise<DatabaseObject[]> {
    if (schema !== "main") return [];
    const allowed = new Set(kinds ?? this.capabilities().objectKinds);
    const db = await this.db();
    const rows = db.prepare(
      `SELECT name, type
         FROM sqlite_master
        WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
        ORDER BY type, name`,
    ).all() as Array<{ name: string; type: "table" | "view" }>;
    return rows.flatMap((row) => {
      const kind: DatabaseObjectKind = row.type;
      return allowed.has(kind)
        ? [objectFromIdentity({ schema: "main", name: row.name, kind })]
        : [];
    });
  }

  async describeObject(object: DatabaseObject): Promise<DatabaseObjectDetails> {
    const live = await this.listObjects(object.schema, [object.kind]);
    if (!live.some((candidate) => candidate.key === object.key)) {
      throw new Error("Database object was not found in the live catalog.");
    }
    const db = await this.db();
    const name = quoteIdentifier(object.name);
    const columns = (
      db.prepare(`PRAGMA table_info(${name})`).all() as unknown as PragmaColumn[]
    ).map<ColumnInfo>((column) => ({
      name: column.name,
      dataType: column.type || "",
      nullable: column.notnull === 0,
      primaryKey: column.pk > 0,
    }));
    const indexes = (db.prepare(`PRAGMA index_list(${name})`).all() as Array<{
      name: string;
      unique: number;
    }>).map<DatabaseIndex>((index) => {
      const row = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
      ).get(index.name) as { sql?: string | null } | undefined;
      return {
        name: index.name,
        unique: index.unique === 1,
        definition: capDefinition(row?.sql) ?? "",
      };
    });
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${name})`).all() as Array<{
      id: number;
      table: string;
      from: string;
      to: string;
    }>;
    const constraints: DatabaseConstraint[] = foreignKeys.map((foreignKey) => ({
      name: `fk_${object.name}_${foreignKey.id}`,
      type: "FOREIGN KEY",
      definition: `FOREIGN KEY (${foreignKey.from}) REFERENCES ${foreignKey.table} (${foreignKey.to})`,
    }));
    if (columns.some((column) => column.primaryKey)) {
      constraints.unshift({
        name: `pk_${object.name}`,
        type: "PRIMARY KEY",
        definition: `PRIMARY KEY (${columns.filter((column) => column.primaryKey).map((column) => column.name).join(", ")})`,
      });
    }
    const triggers = (db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY name",
    ).all(object.name) as Array<{ name: string; sql: string | null }>).map<DatabaseTrigger>(
      (trigger) => ({ name: trigger.name, definition: capDefinition(trigger.sql) ?? "" }),
    );
    const definitionRow = db.prepare(
      "SELECT sql FROM sqlite_master WHERE name = ? AND type IN ('table', 'view')",
    ).get(object.name) as { sql?: string | null } | undefined;
    const rawDefinition = definitionRow?.sql ?? undefined;
    const definition = capDefinition(rawDefinition);
    const createScript = capDefinition(
      [
        rawDefinition,
        ...indexes.map((index) => index.definition),
        ...triggers.map((trigger) => trigger.definition),
      ]
        .filter((statement): statement is string => Boolean(statement))
        .map(terminateStatement)
        .join("\n\n"),
    );
    return {
      object,
      columns,
      indexes,
      constraints,
      triggers,
      definition,
      createScript,
    };
  }

  async sampleRows(
    table: TableRef,
    limit: number,
    offset?: number,
    query?: RowBrowseQuery,
  ): Promise<RowSample> {
    const name = table.name;
    const max = clampLimit(limit);
    const skip = clampOffset(offset);
    const db = await this.db();
    const columns = (
      db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as unknown as PragmaColumn[]
    ).map<ColumnInfo>((col) => ({
      name: col.name,
      dataType: col.type || "",
      nullable: col.notnull === 0,
      primaryKey: col.pk > 0,
    }));
    const clauses = buildRowBrowseClauses(columns, query, quoteIdentifier, () => "?");
    const rows = db
      .prepare(`SELECT * FROM ${quoteIdentifier(name)}${clauses.whereSql}${clauses.orderBySql} LIMIT ? OFFSET ?`)
      .all(...clauses.values, max, skip) as Array<Record<string, unknown>>;
    return {
      columns,
      rows: rows.map((row) => normalizeRow(row)),
      rowCount: rows.length,
      limit: max,
      offset: skip,
    };
  }

  async *streamRows(
    table: TableRef,
    columns: ColumnInfo[],
    options: StreamRowsOptions = {},
  ): AsyncIterable<Array<Record<string, unknown>>> {
    // Each stream gets its own connection, mirroring the Postgres and MySQL
    // drivers, which check a connection out of their pool for the life of the
    // scan. Sharing the cached handle is not safe here: SQLite cannot nest
    // transactions, so a second concurrent export fails outright with "cannot
    // start a transaction within a transaction", and whichever export finished
    // first would ROLLBACK the snapshot out from under the others still
    // streaming. Always read-only — an export never writes, even on a driver
    // constructed writable.
    const db = await this.openDatabase(true);
    const batchSize = clampLimit(options.batchSize, 1_000);
    const primaryKeys = columns.filter((column) => column.primaryKey);
    const orderColumns = primaryKeys.length > 0
      ? primaryKeys.map((column) => quoteIdentifier(column.name))
      : columns.flatMap((column) => {
          const identifier = quoteIdentifier(column.name);
          return [`typeof(${identifier})`, `hex(${identifier})`];
        });
    const order = orderColumns.length > 0 ? ` ORDER BY ${orderColumns.join(", ")}` : "";
    try {
      const statement = db.prepare(
        `SELECT * FROM ${quoteIdentifier(table.name)}${order} LIMIT ? OFFSET ?`,
      );
      let offset = 0;
      db.exec("BEGIN DEFERRED TRANSACTION");
      while (!options.signal?.aborted) {
        const rows = statement.all(batchSize, offset) as Array<Record<string, unknown>>;
        if (rows.length === 0) break;
        yield rows.map((row) => normalizeRow(row));
        if (rows.length < batchSize) break;
        offset += rows.length;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (options.signal?.aborted) {
        throw new DOMException("Database export cancelled", "AbortError");
      }
    } finally {
      // Closing discards the transaction anyway; the explicit ROLLBACK states
      // the intent, and must not mask an in-flight error if it fails.
      try {
        db.exec("ROLLBACK");
      } catch {
        // No active transaction — BEGIN itself failed, or the scan never ran.
      }
      db.close();
    }
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
      options.primaryKeys.map((column) => {
        const value = tuple[column];
        return typeof value === "boolean" ? Number(value) : value;
      }),
    );

    const db = await this.db();
    db.exec("BEGIN");
    try {
      const info = db.prepare(`DELETE FROM ${table} WHERE ${predicate}`).run(...values);
      const affectedRows = Number(info.changes);
      assertExpectedDeleteCount(options, affectedRows);
      db.exec(options.commit ? "COMMIT" : "ROLLBACK");
      return { affectedRows, rows: [], columns: [], committed: options.commit };
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

function terminateStatement(value: string): string {
  const statement = value.trim();
  return statement.endsWith(";") ? statement : `${statement};`;
}
