import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ConfigStore } from "../src/core/config-store.js";
import { DbPeek } from "../src/core/db-peek.js";
import { DbWrite } from "../src/core/db-write.js";
import { canPreviewWrite, isReadStatement } from "../src/core/db/driver.js";

// node:sqlite is built-in only on Node >=22.5; skip the DB-backed suite below it.
let DatabaseSync: typeof import("node:sqlite").DatabaseSync | undefined;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = undefined;
}
const sqliteAvailable = DatabaseSync !== undefined;

describe.skipIf(!sqliteAvailable)("DbWrite (SQLite)", () => {
  let tempDir: string;
  let dbFile: string;
  let store: ConfigStore;
  let dbPeek: DbPeek;
  let dbWrite: DbWrite;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nomoreide-dbwrite-"));
    dbFile = join(tempDir, "app.db");
    const seed = new DatabaseSync!(dbFile);
    seed.exec(
      `CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL);
       INSERT INTO users (email) VALUES ('a@x.com'), ('b@x.com');`,
    );
    seed.close();

    store = new ConfigStore(join(tempDir, "config.json"));
    await store.registerDatabase({ name: "app", engine: "sqlite", url: dbFile });
    dbPeek = new DbPeek({ configStore: store });
    dbWrite = new DbWrite({ configStore: store });
  });

  afterEach(async () => {
    await dbPeek.closeAll();
    await dbWrite.closeAll();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("rejects writes while the connection is locked", async () => {
    await expect(dbWrite.execute("app", "DELETE FROM users", true)).rejects.toThrow(
      /locked/i,
    );
  });

  test("preview reports affected rows but rolls back", async () => {
    await store.setDatabaseWriteAccess("app", true);
    const outcome = await dbWrite.execute("app", "DELETE FROM users", false);
    expect(outcome.previewUnavailable).toBe(false);
    expect(outcome.affectedRows).toBe(2);
    expect(outcome.committed).toBe(false);
    // Nothing was persisted — the rows are still there.
    const after = await dbPeek.sampleRows("app", "users", 100);
    expect(after.rowCount).toBe(2);
  });

  test("commit persists the change", async () => {
    await store.setDatabaseWriteAccess("app", true);
    const outcome = await dbWrite.execute(
      "app",
      "DELETE FROM users WHERE email = 'a@x.com'",
      true,
    );
    expect(outcome.committed).toBe(true);
    expect(outcome.affectedRows).toBe(1);
    const after = await dbPeek.sampleRows("app", "users", 100);
    expect(after.rowCount).toBe(1);
    expect(after.rows[0]).toMatchObject({ email: "b@x.com" });
  });

  test("INSERT ... RETURNING surfaces the returned row", async () => {
    await store.setDatabaseWriteAccess("app", true);
    const outcome = await dbWrite.execute(
      "app",
      "INSERT INTO users (email) VALUES ('c@x.com') RETURNING id, email",
      true,
    );
    expect(outcome.committed).toBe(true);
    expect(outcome.rows?.[0]).toMatchObject({ email: "c@x.com" });
  });

  test("rejects an empty statement", async () => {
    await store.setDatabaseWriteAccess("app", true);
    await expect(dbWrite.execute("app", "   ", true)).rejects.toThrow(/empty/);
  });

  test("re-locking blocks further writes", async () => {
    await store.setDatabaseWriteAccess("app", true);
    await store.setDatabaseWriteAccess("app", false);
    await expect(dbWrite.execute("app", "DELETE FROM users", true)).rejects.toThrow(
      /locked/i,
    );
  });
});

describe("write-path statement classification", () => {
  test("isReadStatement recognizes reads, not writes", () => {
    expect(isReadStatement("SELECT * FROM users")).toBe(true);
    expect(isReadStatement("  explain analyze select 1")).toBe(true);
    expect(isReadStatement("DELETE FROM users")).toBe(false);
    expect(isReadStatement("INSERT INTO users VALUES (1)")).toBe(false);
    expect(isReadStatement("WITH x AS (...) DELETE FROM users")).toBe(false);
  });

  test("canPreviewWrite refuses only MySQL DDL", () => {
    expect(canPreviewWrite("mysql", "DROP TABLE users")).toBe(false);
    expect(canPreviewWrite("mysql", "DELETE FROM users")).toBe(true);
    // Postgres/SQLite have transactional DDL, so previews roll back cleanly.
    expect(canPreviewWrite("postgres", "DROP TABLE users")).toBe(true);
    expect(canPreviewWrite("sqlite", "DROP TABLE users")).toBe(true);
  });
});
