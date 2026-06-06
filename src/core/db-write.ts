import type { ConfigStore } from "./config-store.js";
import type { DatabaseConnection, DatabaseEngine } from "./types.js";
import {
  canPreviewWrite,
  type DbWriteDriver,
  type WriteResult,
} from "./db/driver.js";
import { MysqlDriver } from "./db/mysql-driver.js";
import { PostgresDriver } from "./db/postgres-driver.js";
import { SqliteDriver } from "./db/sqlite-driver.js";

/** A write run, or a flag that the statement could not be safely previewed. */
export interface WriteOutcome extends Partial<WriteResult> {
  engine: DatabaseEngine;
  /** True when a preview was requested but the engine can't dry-run it. */
  previewUnavailable: boolean;
}

export interface DbWriteOptions {
  configStore: ConfigStore;
}

/**
 * Write-capable counterpart to {@link DbPeek}, kept deliberately separate so the
 * read-only browser can never reach a write. Every connection here is gated by
 * a per-connection `writeUnlocked` flag the user sets explicitly — and this
 * surface is never exposed to the agent/MCP layer, only the human web UI.
 */
export class DbWrite {
  private readonly configStore: ConfigStore;
  private readonly drivers = new Map<string, DbWriteDriver>();

  constructor(options: DbWriteOptions) {
    this.configStore = options.configStore;
  }

  /**
   * Run a write. With `commit: false` the statement is executed in a
   * transaction and rolled back so the caller can preview the affected-row
   * count; with `commit: true` it is persisted. Throws if the connection is
   * locked.
   */
  async execute(
    name: string,
    sql: string,
    commit: boolean,
  ): Promise<WriteOutcome> {
    const connection = await this.resolveUnlocked(name);
    // A preview that would actually persist (MySQL DDL auto-commits) is unsafe;
    // surface that instead of silently running it.
    if (!commit && !canPreviewWrite(connection.engine, sql)) {
      return { engine: connection.engine, previewUnavailable: true };
    }
    const driver = this.driverFor(connection);
    const result = await driver.executeWrite(sql, commit);
    return { engine: connection.engine, previewUnavailable: false, ...result };
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.drivers.values()].map((driver) => driver.close().catch(() => {})),
    );
    this.drivers.clear();
  }

  /** Resolve a connection and assert the user has unlocked writes on it. */
  private async resolveUnlocked(name: string): Promise<DatabaseConnection> {
    const config = await this.configStore.load();
    const connection = config.databases.find((item) => item.name === name);
    if (!connection) {
      throw new Error(`Database connection "${name}" is not registered.`);
    }
    if (!connection.writeUnlocked) {
      throw new Error(
        `Write access is locked for "${name}". Unlock it before running writes.`,
      );
    }
    return connection;
  }

  private driverFor(connection: DatabaseConnection): DbWriteDriver {
    const key = `${connection.engine}::${connection.url}`;
    let driver = this.drivers.get(key);
    if (!driver) {
      driver = createWriteDriver(connection.engine, connection.url);
      this.drivers.set(key, driver);
    }
    return driver;
  }
}

function createWriteDriver(
  engine: DatabaseEngine,
  url: string,
): DbWriteDriver {
  switch (engine) {
    case "postgres":
      return new PostgresDriver(url, { writable: true });
    case "mysql":
      return new MysqlDriver(url, { writable: true });
    case "sqlite":
      return new SqliteDriver(url, { writable: true });
    default:
      throw new Error(`Unsupported database engine: ${engine satisfies never}`);
  }
}
