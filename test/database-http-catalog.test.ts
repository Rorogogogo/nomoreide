import { afterEach, describe, expect, test, vi } from "vitest";
import { httpDatabaseApi } from "../src/web/client/src/lib/api/database-http";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HTTP database catalog adapter", () => {
  test("encodes lazy schema, object, detail, and row requests", async () => {
    const fetch = vi.fn().mockImplementation(async (url: string) => {
      const payload = url.includes("/schemas")
        ? { ok: true, schemas: [{ name: "main" }] }
        : url.includes("/objects")
          ? { ok: true, objects: [] }
          : url.includes("/details")
            ? { ok: true, details: { object: {}, columns: [], indexes: [], constraints: [], triggers: [] } }
            : { ok: true, object: {}, table: {}, columns: [], rows: [], rowCount: 0, limit: 50, offset: 100 };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetch);

    await httpDatabaseApi.getDatabaseSchemas("app/db");
    await httpDatabaseApi.getDatabaseObjects("app/db", "my schema");
    await httpDatabaseApi.getDatabaseObjectDetails("app/db", "opaque+/=");
    await httpDatabaseApi.getDatabaseObjectRows("app/db", "opaque+/=", 50, 100);

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/databases/app%2Fdb/catalog/schemas",
      "/api/databases/app%2Fdb/catalog/objects?schema=my%20schema",
      "/api/databases/app%2Fdb/catalog/details?key=opaque%2B%2F%3D",
      "/api/databases/app%2Fdb/catalog/rows?key=opaque%2B%2F%3D&limit=50&offset=100",
    ]);
  });

  test("posts structured primary keys to the guarded row-delete endpoint", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        engine: "sqlite",
        previewUnavailable: false,
        affectedRows: 2,
        committed: false,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await httpDatabaseApi.deleteDatabaseRows("app/db", {
      objectKey: "opaque-users",
      keys: [{ id: 1 }, { id: 2 }],
      mode: "preview",
    });

    expect(fetch).toHaveBeenCalledWith(
      "/api/databases/app%2Fdb/catalog/rows/delete",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          key: "opaque-users",
          tuples: JSON.stringify([{ id: 1 }, { id: 2 }]),
          mode: "preview",
        }),
      },
    );
  });
});
