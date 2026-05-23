import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ConfigStore } from "../src/core/config-store.js";
import {
  DbPeek,
  engineFromUrl,
  maskConnectionUrl,
} from "../src/core/db-peek.js";

let tempDir: string;
let dbFile: string;
let store: ConfigStore;
let dbPeek: DbPeek;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-dbpeek-"));
  dbFile = join(tempDir, "app.db");

  // Seed a SQLite fixture, then close it so DbPeek opens it read-only.
  const seed = new DatabaseSync(dbFile);
  seed.exec(
    `CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, active INTEGER);
     INSERT INTO users (email, active) VALUES ('a@x.com', 1), ('b@x.com', 0);
     CREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL);`,
  );
  seed.close();

  store = new ConfigStore(join(tempDir, "config.json"));
  await store.registerDatabase({ name: "app", engine: "sqlite", url: dbFile });
  dbPeek = new DbPeek({ configStore: store });
});

afterEach(async () => {
  await dbPeek.closeAll();
  await rm(tempDir, { recursive: true, force: true });
});

describe("DbPeek (SQLite)", () => {
  test("lists registered connections (SQLite path is not masked)", async () => {
    const connections = await dbPeek.listConnections();
    expect(connections).toEqual([{ name: "app", engine: "sqlite", url: dbFile }]);
  });

  test("lists tables in the database", async () => {
    const tables = await dbPeek.listTables("app");
    expect(tables.map((t) => t.qualifiedName)).toEqual(["orders", "users"]);
  });

  test("samples rows with column schema and primary keys", async () => {
    const sample = await dbPeek.sampleRows("app", "users", 100);
    expect(sample.rowCount).toBe(2);
    expect(sample.rows[0]).toMatchObject({ email: "a@x.com" });
    const pk = sample.columns.find((c) => c.name === "id");
    expect(pk?.primaryKey).toBe(true);
    const email = sample.columns.find((c) => c.name === "email");
    expect(email?.nullable).toBe(false);
  });

  test("respects the row limit", async () => {
    const sample = await dbPeek.sampleRows("app", "users", 1);
    expect(sample.rowCount).toBe(1);
  });

  test("rejects tables that are not in the live catalog (injection guard)", async () => {
    await expect(
      dbPeek.sampleRows("app", "users; DROP TABLE users", 10),
    ).rejects.toThrow(/not found/);
  });

  test("throws for an unregistered connection", async () => {
    await expect(dbPeek.listTables("missing")).rejects.toThrow(/not registered/);
  });
});

describe("connection-string helpers", () => {
  test("engineFromUrl recognizes each engine", () => {
    expect(engineFromUrl("postgres://u:p@h/db")).toBe("postgres");
    expect(engineFromUrl("postgresql://u:p@h/db")).toBe("postgres");
    expect(engineFromUrl("mysql://u:p@h/db")).toBe("mysql");
    expect(engineFromUrl("mariadb://u:p@h/db")).toBe("mysql");
    expect(engineFromUrl("/var/data/app.sqlite")).toBe("sqlite");
    expect(engineFromUrl("file:./local.db")).toBe("sqlite");
    expect(engineFromUrl("redis://h:6379")).toBeNull();
  });

  test("maskConnectionUrl redacts the password but keeps SQLite paths", () => {
    expect(maskConnectionUrl("postgres", "postgres://user:secret@host:5432/db")).toBe(
      "postgres://user:****@host:5432/db",
    );
    expect(maskConnectionUrl("sqlite", "/abs/path/app.db")).toBe("/abs/path/app.db");
  });
});
