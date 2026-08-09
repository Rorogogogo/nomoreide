import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ConfigStore } from "../src/core/config-store.js";
import { createWebServer } from "../src/web/server.js";

let DatabaseSync: typeof import("node:sqlite").DatabaseSync | undefined;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = undefined;
}

describe.skipIf(!DatabaseSync)("database catalog HTTP routes", () => {
  let tempDir: string;
  let server: Awaited<ReturnType<ReturnType<typeof createWebServer>["start"]>>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nomoreide-db-routes-"));
    const dbFile = join(tempDir, "app.db");
    const database = new DatabaseSync!(dbFile);
    database.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, api_token TEXT, note TEXT); INSERT INTO users (email, api_token, note) VALUES ('a@x.com', 'top-secret', '=1+1');");
    database.close();
    const configPath = join(tempDir, "config.json");
    await new ConfigStore(configPath).registerDatabase({ name: "app", engine: "sqlite", url: dbFile });
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();
  });

  afterEach(async () => {
    await server?.stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("walks schema to opaque object details and sampled rows", async () => {
    const schemas = await fetch(`${server.url}/api/databases/app/catalog/schemas`).then((response) => response.json());
    expect(schemas).toEqual({ ok: true, schemas: [{ name: "main" }] });

    const objectResponse = await fetch(`${server.url}/api/databases/app/catalog/objects?schema=main`).then((response) => response.json());
    const users = objectResponse.objects.find((object: { name: string }) => object.name === "users");
    expect(users.key).toBeTruthy();

    const details = await fetch(`${server.url}/api/databases/app/catalog/details?key=${encodeURIComponent(users.key)}`).then((response) => response.json());
    expect(details.details.columns).toContainEqual(expect.objectContaining({ name: "email", nullable: false }));

    const rows = await fetch(`${server.url}/api/databases/app/catalog/rows?key=${encodeURIComponent(users.key)}&limit=50&offset=0`).then((response) => response.json());
    expect(rows).toMatchObject({ ok: true, rowCount: 1, rows: [{ email: "a@x.com" }] });
  });

  test("streams complete masked CSV and JSON downloads", async () => {
    const objectResponse = await fetch(
      `${server.url}/api/databases/app/catalog/objects?schema=main`,
    ).then((response) => response.json());
    const users = objectResponse.objects.find(
      (object: { name: string }) => object.name === "users",
    );

    const csvResponse = await fetch(
      `${server.url}/api/databases/app/catalog/export?key=${encodeURIComponent(users.key)}&format=csv`,
    );
    expect(csvResponse.status).toBe(200);
    expect(csvResponse.headers.get("content-disposition")).toMatch(
      /app-users-\d{4}-\d{2}-\d{2}\.csv/,
    );
    expect(await csvResponse.text()).toBe(
      "id,email,api_token,note\r\n1,a@x.com,••••,'=1+1\r\n",
    );

    const jsonResponse = await fetch(
      `${server.url}/api/databases/app/catalog/export?key=${encodeURIComponent(users.key)}&format=json`,
    );
    expect(jsonResponse.status).toBe(200);
    expect(await jsonResponse.json()).toEqual([
      { id: 1, email: "a@x.com", api_token: "••••", note: "=1+1" },
    ]);
  });

  test("rejects invalid export formats before starting a download", async () => {
    const response = await fetch(
      `${server.url}/api/databases/app/catalog/export?key=missing&format=xlsx`,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "format must be csv or json",
    });
  });

  test("exports beyond the 5,000-row browse sampling cap", async () => {
    const database = new DatabaseSync!(join(tempDir, "app.db"));
    database.exec(`
      WITH RECURSIVE sequence(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 5005
      )
      INSERT INTO users (email) SELECT 'user-' || value || '@x.com' FROM sequence;
    `);
    database.close();
    const objectResponse = await fetch(
      `${server.url}/api/databases/app/catalog/objects?schema=main`,
    ).then((response) => response.json());
    const users = objectResponse.objects.find(
      (object: { name: string }) => object.name === "users",
    );

    const rows = await fetch(
      `${server.url}/api/databases/app/catalog/export?key=${encodeURIComponent(users.key)}&format=json`,
    ).then((response) => response.json());
    expect(rows).toHaveLength(5006);
    expect(rows.at(-1)).toMatchObject({ email: "user-5005@x.com" });
  });

  test("previews and commits structured primary-key row deletion", async () => {
    await fetch(`${server.url}/api/databases/app/write-access`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ unlocked: "true" }),
    });
    const objectResponse = await fetch(
      `${server.url}/api/databases/app/catalog/objects?schema=main`,
    ).then((response) => response.json());
    const users = objectResponse.objects.find(
      (object: { name: string }) => object.name === "users",
    );

    const deleteRows = (mode: "preview" | "commit", expected?: number) =>
      fetch(`${server.url}/api/databases/app/catalog/rows/delete`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          key: users.key,
          tuples: JSON.stringify([{ id: 1 }]),
          mode,
          ...(expected === undefined
            ? {}
            : { expectedAffectedRows: String(expected) }),
        }),
      }).then((response) => response.json());

    await expect(deleteRows("preview")).resolves.toMatchObject({
      ok: true,
      affectedRows: 1,
      committed: false,
      primaryKeys: ["id"],
    });
    const afterPreview = await fetch(
      `${server.url}/api/databases/app/catalog/rows?key=${encodeURIComponent(users.key)}`,
    ).then((response) => response.json());
    expect(afterPreview.rowCount).toBe(1);

    await expect(deleteRows("commit")).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/preview count/i),
    });
    const afterRejectedCommit = await fetch(
      `${server.url}/api/databases/app/catalog/rows?key=${encodeURIComponent(users.key)}`,
    ).then((response) => response.json());
    expect(afterRejectedCommit.rowCount).toBe(1);

    await expect(deleteRows("commit", 1)).resolves.toMatchObject({
      ok: true,
      affectedRows: 1,
      committed: true,
    });
    const afterCommit = await fetch(
      `${server.url}/api/databases/app/catalog/rows?key=${encodeURIComponent(users.key)}`,
    ).then((response) => response.json());
    expect(afterCommit.rowCount).toBe(0);
  });
});
