import type { ConfigStore } from "./config-store.js";
import type { DatabaseConnection, DatabaseEngine } from "./types.js";
import {
  canPreviewWrite,
  type DeleteRowsOptions,
  type DbWriteDriver,
  type PrimaryKeyTuple,
  type PrimaryKeyValue,
  type WriteResult,
} from "./db/driver.js";
import {
  resolveCatalogObject,
  type DatabaseObject,
} from "./db/catalog.js";
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

export interface DeleteRowsOutcome extends WriteOutcome {
  /** Live-catalog primary key order used to bind every tuple. */
  primaryKeys: string[];
}

const MAX_DELETE_TUPLES = 100;
const MAX_DELETE_PARAMETERS = 500;
const MASKED_VALUE = /^•+$/;

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

  /**
   * Delete rows identified by complete primary-key tuples. The object and its
   * primary-key metadata are resolved from the live catalog; caller-provided
   * names are never used as SQL identifiers.
   */
  async deleteRows(
    name: string,
    objectKey: string,
    tuples: unknown,
    commit: boolean,
    expectedAffectedRows?: number,
  ): Promise<DeleteRowsOutcome> {
    const connection = await this.resolveUnlocked(name);
    const driver = this.driverFor(connection);
    const object = await this.resolveObject(driver, objectKey);
    if (object.kind !== "table") {
      throw new Error("Only live catalog tables support row deletion.");
    }

    const details = await driver.describeObject(object);
    const primaryKeys = details.columns
      .filter((column) => column.primaryKey)
      .map((column) => column.name);
    if (primaryKeys.length === 0) {
      throw new Error(
        `Table "${object.qualifiedName}" has no primary key; rows cannot be deleted safely.`,
      );
    }

    const validatedTuples = validatePrimaryKeyTuples(tuples, primaryKeys);
    const expected = validateExpectedAffectedRows(expectedAffectedRows);
    if (commit && expected === undefined) {
      throw new Error("A confirmed preview count is required before deleting rows.");
    }
    if (commit && expected !== validatedTuples.length) {
      throw new Error(
        "The confirmed preview count must match the selected primary-key tuples.",
      );
    }
    const options: DeleteRowsOptions = {
      table: {
        schema: object.schema,
        name: object.name,
        qualifiedName: object.qualifiedName,
      },
      primaryKeys,
      tuples: validatedTuples,
      commit,
      expectedAffectedRows: expected,
    };
    const result = await driver.deleteRows(options);
    return {
      engine: connection.engine,
      previewUnavailable: false,
      primaryKeys,
      ...result,
    };
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

  private async resolveObject(
    driver: DbWriteDriver,
    key: string,
  ): Promise<DatabaseObject> {
    if (!key) throw new Error("Database object key is required.");
    const schemas = await driver.listSchemas();
    for (const schema of schemas) {
      const objects = await driver.listObjects(schema.name);
      const match = objects.find((object) => object.key === key);
      if (match) return match;
    }
    return resolveCatalogObject([], key);
  }
}

function validatePrimaryKeyTuples(
  value: unknown,
  primaryKeys: string[],
): PrimaryKeyTuple[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("At least one primary-key tuple is required.");
  }
  if (value.length > MAX_DELETE_TUPLES) {
    throw new Error(`No more than ${MAX_DELETE_TUPLES} rows can be deleted at once.`);
  }
  if (value.length * primaryKeys.length > MAX_DELETE_PARAMETERS) {
    throw new Error(
      `Row deletion is limited to ${MAX_DELETE_PARAMETERS} bound primary-key values.`,
    );
  }

  const requiredNames = new Set(primaryKeys);
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`Primary-key tuple ${index + 1} must be an object.`);
    }
    const record = candidate as Record<string, unknown>;
    const names = Object.keys(record);
    if (
      names.length !== primaryKeys.length ||
      names.some((column) => !requiredNames.has(column))
    ) {
      throw new Error(
        `Primary-key tuple ${index + 1} must contain exactly: ${primaryKeys.join(", ")}.`,
      );
    }

    const tuple: PrimaryKeyTuple = {};
    for (const column of primaryKeys) {
      tuple[column] = validatePrimaryKeyValue(record[column], index, column);
    }
    const identity = primaryKeys
      .map((column) => `${typeof tuple[column]}:${JSON.stringify(tuple[column])}`)
      .join("\u0000");
    if (seen.has(identity)) {
      throw new Error(`Primary-key tuple ${index + 1} is a duplicate.`);
    }
    seen.add(identity);
    return tuple;
  });
}

function validatePrimaryKeyValue(
  value: unknown,
  tupleIndex: number,
  column: string,
): PrimaryKeyValue {
  const scalar =
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
  if (!scalar || value === null) {
    throw new Error(
      `Primary-key value "${column}" in tuple ${tupleIndex + 1} must be a non-null scalar.`,
    );
  }
  if (typeof value === "string" && MASKED_VALUE.test(value)) {
    throw new Error(
      `Primary-key value "${column}" in tuple ${tupleIndex + 1} is masked and cannot be used for deletion.`,
    );
  }
  return value as PrimaryKeyValue;
}

function validateExpectedAffectedRows(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DELETE_TUPLES) {
    throw new Error("expectedAffectedRows must be a non-negative integer within the delete limit.");
  }
  return value;
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
