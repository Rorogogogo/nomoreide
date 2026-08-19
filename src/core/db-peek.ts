import { join } from "node:path";
import type { ConfigStore } from "./config-store.js";
import { readEnvFile, entriesFromLines } from "./env-file.js";
import type { DatabaseConnection, DatabaseEngine } from "./types.js";
import type {
  DbDriver,
  QueryResult,
  RowBrowseQuery,
  RowSample,
  TableRef,
} from "./db/driver.js";
import type { ColumnInfo, StreamRowsOptions } from "./db/driver.js";
import { maskDatabaseRows } from "./db/data-masking.js";
import {
  resolveCatalogObject,
  tableRefForObject,
  type DatabaseCapabilities,
  type DatabaseObject,
  type DatabaseObjectDetails,
  type DatabaseObjectKind,
  type DatabaseSchema,
} from "./db/catalog.js";
import { MysqlDriver } from "./db/mysql-driver.js";
import { PostgresDriver } from "./db/postgres-driver.js";
import { SqliteDriver } from "./db/sqlite-driver.js";

export interface MaskedConnection {
  name: string;
  engine: DatabaseEngine;
  /** Connection URL with any password redacted (path left intact for SQLite). */
  url: string;
  /** Whether the user has unlocked write access for this connection. */
  writeUnlocked: boolean;
  /** Project directory the connection is classified under, if any. */
  projectPath?: string;
}

/** A DB connection string discovered in a service's `.env` file. */
export interface DetectedConnection {
  service: string;
  /** The service's working directory — provenance for project classification. */
  cwd: string;
  key: string;
  engine: DatabaseEngine;
  url: string;
  maskedUrl: string;
}

export interface DbPeekOptions {
  configStore: ConfigStore;
}

/**
 * DB Peek: a read-only table browser. Owns its own bundled drivers (Postgres,
 * MySQL, SQLite) — it never borrows the agent's MCP database tooling. Drivers
 * are cached per connection URL and reused across requests.
 */
export class DbPeek {
  private readonly configStore: ConfigStore;
  private readonly drivers = new Map<string, DbDriver>();

  constructor(options: DbPeekOptions) {
    this.configStore = options.configStore;
  }

  async listConnections(): Promise<MaskedConnection[]> {
    const config = await this.configStore.load();
    return config.databases.map((connection) => ({
      name: connection.name,
      engine: connection.engine,
      url: maskConnectionUrl(connection.engine, connection.url),
      writeUnlocked: connection.writeUnlocked ?? false,
      projectPath: connection.projectPath,
    }));
  }

  async listTables(name: string): Promise<TableRef[]> {
    const driver = await this.driverFor(await this.resolve(name));
    return driver.listTables();
  }

  async capabilities(name: string): Promise<DatabaseCapabilities> {
    const driver = await this.driverFor(await this.resolve(name));
    return driver.capabilities();
  }

  async listSchemas(name: string): Promise<DatabaseSchema[]> {
    const driver = await this.driverFor(await this.resolve(name));
    return driver.listSchemas();
  }

  async listObjects(
    name: string,
    schema: string,
    kinds?: DatabaseObjectKind[],
  ): Promise<DatabaseObject[]> {
    const driver = await this.driverFor(await this.resolve(name));
    return driver.listObjects(schema, kinds);
  }

  async objectDetails(name: string, key: string): Promise<DatabaseObjectDetails> {
    const driver = await this.driverFor(await this.resolve(name));
    const object = await this.resolveObject(driver, key);
    return driver.describeObject(object);
  }

  async sampleObject(
    name: string,
    key: string,
    limit: number,
    offset = 0,
    query?: RowBrowseQuery,
  ): Promise<{ engine: DatabaseEngine; object: DatabaseObject; table: TableRef } & RowSample> {
    const connection = await this.resolve(name);
    const driver = await this.driverFor(connection);
    const object = await this.resolveObject(driver, key);
    const table = tableRefForObject(object);
    const sample = await driver.sampleRows(table, limit, offset, query);
    return {
      engine: connection.engine,
      object,
      table,
      ...sample,
      rows: maskDatabaseRows(sample.rows),
    };
  }

  async sampleRows(
    name: string,
    qualifiedName: string,
    limit: number,
    offset = 0,
  ): Promise<{ engine: DatabaseEngine; table: TableRef } & RowSample> {
    const connection = await this.resolve(name);
    const driver = await this.driverFor(connection);
    const table = await this.resolveTable(driver, qualifiedName);
    const sample = await driver.sampleRows(table, limit, offset);
    return { engine: connection.engine, table, ...sample };
  }

  async exportObjectSource(
    name: string,
    key: string,
    options: StreamRowsOptions = {},
  ): Promise<{
    engine: DatabaseEngine;
    object: DatabaseObject;
    columns: ColumnInfo[];
    rows: AsyncIterable<Array<Record<string, unknown>>>;
  }> {
    const connection = await this.resolve(name);
    const driver = await this.driverFor(connection);
    const object = await this.resolveObject(driver, key);
    if (!["table", "view", "materializedView"].includes(object.kind)) {
      throw new Error("This database object cannot be exported.");
    }
    const table = tableRefForObject(object);
    const columns = (await driver.describeObject(object)).columns;
    return {
      engine: connection.engine,
      object,
      columns,
      rows: driver.streamRows(table, columns, options),
    };
  }

  /** Run a user-authored read-only query against a registered connection. */
  async runQuery(
    name: string,
    sql: string,
    maxRows = 100,
  ): Promise<{ engine: DatabaseEngine } & QueryResult> {
    const connection = await this.resolve(name);
    const driver = await this.driverFor(connection);
    const result = await driver.runQuery(sql, maxRows);
    return { engine: connection.engine, ...result };
  }

  /** Test an unsaved connection without caching it. */
  async test(engine: DatabaseEngine, url: string): Promise<void> {
    const driver = createDriver(engine, url);
    try {
      await driver.testConnection();
    } finally {
      await driver.close().catch(() => {});
    }
  }

  async register(input: {
    name: string;
    engine: DatabaseEngine;
    url: string;
    projectPath?: string;
    replace?: boolean;
    check?: boolean;
  }): Promise<MaskedConnection> {
    const name = input.name.trim();
    if (!name) throw new Error("Database connection name is required.");
    const config = await this.configStore.load();
    const existing = config.databases.find((connection) => connection.name === name);
    if (existing && !input.replace) {
      throw new Error(`Database connection "${name}" already exists. Set replace=true to replace it.`);
    }
    if (input.check !== false) {
      try {
        await this.test(input.engine, input.url);
      } catch (error) {
        throw new Error(redactDatabaseError(input.engine, input.url, error));
      }
    }
    await this.configStore.registerDatabase({
      name,
      engine: input.engine,
      url: input.url,
      projectPath: input.projectPath?.trim() || undefined,
      // MCP registration can never carry write authorization to a new target.
      writeUnlocked: false,
    });
    return {
      name,
      engine: input.engine,
      url: maskConnectionUrl(input.engine, input.url),
      writeUnlocked: false,
      projectPath: input.projectPath?.trim() || undefined,
    };
  }

  async check(name: string): Promise<{ ok: true; connection: MaskedConnection }> {
    const connection = await this.resolve(name);
    try {
      await this.test(connection.engine, connection.url);
    } catch (error) {
      throw new Error(redactDatabaseError(connection.engine, connection.url, error));
    }
    return {
      ok: true,
      connection: {
        name: connection.name,
        engine: connection.engine,
        url: maskConnectionUrl(connection.engine, connection.url),
        writeUnlocked: connection.writeUnlocked ?? false,
        projectPath: connection.projectPath,
      },
    };
  }

  /** Scan registered services' `.env` files for usable connection strings. */
  async detectFromEnv(): Promise<DetectedConnection[]> {
    const config = await this.configStore.load();
    const found: DetectedConnection[] = [];
    const seen = new Set<string>();

    for (const service of config.services) {
      if (!service.cwd) continue;
      const { exists, lines } = await readEnvFile(join(service.cwd, ".env"));
      if (!exists) continue;
      for (const { key, value } of entriesFromLines(lines)) {
        const engine = engineFromUrl(value);
        if (!engine) continue;
        const dedupe = `${engine}:${value}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        found.push({
          service: service.name,
          cwd: service.cwd,
          key,
          engine,
          url: value,
          maskedUrl: maskConnectionUrl(engine, value),
        });
      }
    }
    return found;
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.drivers.values()].map((driver) => driver.close().catch(() => {})),
    );
    this.drivers.clear();
  }

  private async resolve(name: string): Promise<DatabaseConnection> {
    const config = await this.configStore.load();
    const connection = config.databases.find((item) => item.name === name);
    if (!connection) {
      throw new Error(`Database connection "${name}" is not registered.`);
    }
    return connection;
  }

  private async driverFor(connection: DatabaseConnection): Promise<DbDriver> {
    const key = `${connection.engine}::${connection.url}`;
    let driver = this.drivers.get(key);
    if (!driver) {
      driver = createDriver(connection.engine, connection.url);
      this.drivers.set(key, driver);
    }
    return driver;
  }

  /** Only browse tables that actually exist — blocks identifier injection. */
  private async resolveTable(
    driver: DbDriver,
    qualifiedName: string,
  ): Promise<TableRef> {
    const tables = await driver.listTables();
    const table = tables.find((item) => item.qualifiedName === qualifiedName);
    if (!table) {
      throw new Error(`Table "${qualifiedName}" not found.`);
    }
    return table;
  }

  private async resolveObject(driver: DbDriver, key: string): Promise<DatabaseObject> {
    const schemas = await driver.listSchemas();
    for (const schema of schemas) {
      const objects = await driver.listObjects(schema.name);
      const match = objects.find((object) => object.key === key);
      if (match) return match;
    }
    return resolveCatalogObject([], key);
  }
}

function createDriver(engine: DatabaseEngine, url: string): DbDriver {
  switch (engine) {
    case "postgres":
      return new PostgresDriver(url);
    case "mysql":
      return new MysqlDriver(url);
    case "sqlite":
      return new SqliteDriver(url);
    default:
      throw new Error(`Unsupported database engine: ${engine satisfies never}`);
  }
}

/** Guess an engine from a connection string or file path; null if unrecognized. */
export function engineFromUrl(value: string): DatabaseEngine | null {
  const v = value.trim();
  if (/^postgres(ql)?:\/\//i.test(v)) return "postgres";
  if (/^mysql:\/\//i.test(v) || /^mariadb:\/\//i.test(v)) return "mysql";
  if (/^sqlite:\/\//i.test(v) || /^file:.+\.(db|sqlite|sqlite3)/i.test(v)) {
    return "sqlite";
  }
  if (/\.(db|sqlite|sqlite3)$/i.test(v)) return "sqlite";
  return null;
}

/**
 * When editing a connection the client never sees the stored password (it's
 * masked), so an edit that leaves the password blank arrives password-less.
 * Splice the previously-stored password back in so it isn't wiped. SQLite has
 * no password, and a freshly-supplied password always wins.
 */
export function mergeStoredPassword(
  engine: DatabaseEngine,
  nextUrl: string,
  existingUrl: string,
): string {
  if (engine === "sqlite") return nextUrl;
  try {
    const next = new URL(nextUrl);
    if (next.password) return nextUrl;
    const existing = new URL(existingUrl);
    if (!existing.password) return nextUrl;
    next.password = decodeURIComponent(existing.password);
    return next.toString();
  } catch {
    return nextUrl;
  }
}

/** Redact the password from a URL; SQLite paths are returned unchanged. */
export function maskConnectionUrl(engine: DatabaseEngine, url: string): string {
  if (engine === "sqlite") return url;
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "****";
    for (const key of parsed.searchParams.keys()) {
      if (isSensitiveConnectionParameter(key)) {
        parsed.searchParams.set(key, "****");
      }
    }
    return parsed.toString();
  } catch {
    // Not a parseable URL — mask the middle defensively.
    if (url.length <= 8) return "****";
    return `${url.slice(0, 4)}****${url.slice(-4)}`;
  }
}

/** Query-string fields that must never survive import or public serialization. */
export function isSensitiveConnectionParameter(key: string): boolean {
  return /password|passwd|secret|token|api[_-]?key/i.test(key);
}

export function redactDatabaseError(
  engine: DatabaseEngine,
  url: string,
  error: unknown,
): string {
  let message = error instanceof Error ? error.message : String(error);
  const masked = maskConnectionUrl(engine, url);
  message = message.replaceAll(url, masked);
  if (engine !== "sqlite") {
    try {
      const parsed = new URL(url);
      const password = decodeURIComponent(parsed.password);
      if (password) message = message.replaceAll(password, "****");
      if (parsed.password) message = message.replaceAll(parsed.password, "****");
    } catch {
      // The full unparseable value was already replaced above.
    }
  }
  return message;
}
