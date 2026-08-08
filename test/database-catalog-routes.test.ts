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
    database.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL); INSERT INTO users (email) VALUES ('a@x.com');");
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
