import { join } from "node:path";
import type { ConfigStore } from "./config-store.js";
import { readEnvFile, entriesFromLines } from "./env-file.js";
import type { DatabaseConnection, DatabaseEngine } from "./types.js";
import type { DbDriver, RowSample, TableRef } from "./db/driver.js";
import { MysqlDriver } from "./db/mysql-driver.js";
import { PostgresDriver } from "./db/postgres-driver.js";
import { SqliteDriver } from "./db/sqlite-driver.js";

export interface MaskedConnection {
  name: string;
  engine: DatabaseEngine;
  /** Connection URL with any password redacted (path left intact for SQLite). */
  url: string;
}

/** A DB connection string discovered in a service's `.env` file. */
export interface DetectedConnection {
  service: string;
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
    }));
  }

  async listTables(name: string): Promise<TableRef[]> {
    const driver = await this.driverFor(await this.resolve(name));
    return driver.listTables();
  }

  async sampleRows(
    name: string,
    qualifiedName: string,
    limit: number,
  ): Promise<{ engine: DatabaseEngine; table: TableRef } & RowSample> {
    const connection = await this.resolve(name);
    const driver = await this.driverFor(connection);
    const table = await this.resolveTable(driver, qualifiedName);
    const sample = await driver.sampleRows(table, limit);
    return { engine: connection.engine, table, ...sample };
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

/** Redact the password from a URL; SQLite paths are returned unchanged. */
export function maskConnectionUrl(engine: DatabaseEngine, url: string): string {
  if (engine === "sqlite") return url;
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "****";
    return parsed.toString();
  } catch {
    // Not a parseable URL — mask the middle defensively.
    if (url.length <= 8) return "****";
    return `${url.slice(0, 4)}****${url.slice(-4)}`;
  }
}
