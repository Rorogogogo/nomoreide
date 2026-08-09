import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ColumnInfo, TableRef } from "../src/core/db/driver.js";
import { SqliteDriver } from "../src/core/db/sqlite-driver.js";

let DatabaseSync: typeof import("node:sqlite").DatabaseSync | undefined;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = undefined;
}

const ROW_COUNT = 2_500;
const table: TableRef = { name: "users", qualifiedName: "users" };
const columns: ColumnInfo[] = [
  { name: "id", dataType: "INTEGER", nullable: false, primaryKey: true },
  { name: "email", dataType: "TEXT", nullable: false, primaryKey: false },
];

describe.skipIf(!DatabaseSync)("sqlite streamRows", () => {
  let tempDir: string;
  let dbFile: string;
  let driver: SqliteDriver;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nomoreide-stream-rows-"));
    dbFile = join(tempDir, "app.db");
    const database = new DatabaseSync!(dbFile);
    database.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL);");
    database.exec(`
      WITH RECURSIVE sequence(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < ${ROW_COUNT}
      )
      INSERT INTO users (email) SELECT 'user-' || value || '@x.com' FROM sequence;
    `);
    database.close();
    driver = new SqliteDriver(dbFile);
  });

  afterEach(async () => {
    await driver?.close().catch(() => {});
    await rm(tempDir, { recursive: true, force: true });
  });

  async function drain(signal?: AbortSignal): Promise<number> {
    let rows = 0;
    for await (const batch of driver.streamRows(table, columns, { batchSize: 500, signal })) {
      rows += batch.length;
    }
    return rows;
  }

  // Regression: streamRows used to run on the driver's single cached
  // connection, so a second concurrent export failed with "cannot start a
  // transaction within a transaction", and whichever export finished first
  // rolled the snapshot back out from under the others mid-stream.
  test("runs concurrent scans without sharing a transaction", async () => {
    const results = await Promise.all([drain(), drain(), drain()]);
    expect(results).toEqual([ROW_COUNT, ROW_COUNT, ROW_COUNT]);
  });

  test("leaves the connection usable after a scan is abandoned mid-stream", async () => {
    const iterator = driver.streamRows(table, columns, { batchSize: 500 })[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    // Disposing early runs the generator's finally, which must release the
    // transaction and close that scan's connection rather than the shared one.
    await iterator.return?.();

    await expect(drain()).resolves.toBe(ROW_COUNT);
    const sample = await driver.sampleRows(table, 1);
    expect(sample.rowCount).toBe(1);
  });

  test("aborting mid-scan rejects and still frees the connection", async () => {
    const controller = new AbortController();
    const scan = (async () => {
      let rows = 0;
      for await (const batch of driver.streamRows(table, columns, {
        batchSize: 500,
        signal: controller.signal,
      })) {
        rows += batch.length;
        if (rows >= 500) controller.abort();
      }
      return rows;
    })();

    await expect(scan).rejects.toThrow(/cancelled/i);
    await expect(drain()).resolves.toBe(ROW_COUNT);
  });
});
