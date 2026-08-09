import { afterEach, describe, expect, test, vi } from "vitest";
import { httpDatabaseApi } from "../src/web/client/src/lib/api/database-http";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HTTP database catalog adapter", () => {
  test("builds a direct all-row download URL without buffering it", async () => {
    await expect(
      httpDatabaseApi.exportDatabaseObject("app/db", "opaque+/=", "csv", "ignored.csv"),
    ).resolves.toEqual({
      delivery: "browser",
      url: "/api/databases/app%2Fdb/catalog/export?key=opaque%2B%2F%3D&format=csv",
    });
  });

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

  test("encodes structured row filters and sorting", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        object: {},
        table: {},
        columns: [],
        rows: [],
        rowCount: 0,
        limit: 25,
        offset: 0,
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetch);

    await httpDatabaseApi.getDatabaseObjectRows("app", "opaque", 25, 0, {
      filters: [{ column: "name", operator: "contains", value: "sam%ple" }],
      sort: { column: "created_at", direction: "desc" },
    });

    const request = new URL(String(fetch.mock.calls[0]?.[0]), "http://localhost");
    expect(JSON.parse(request.searchParams.get("filters") ?? "[]")).toEqual([
      { column: "name", operator: "contains", value: "sam%ple" },
    ]);
    expect(request.searchParams.get("sortColumn")).toBe("created_at");
    expect(request.searchParams.get("sortDirection")).toBe("desc");
  });

  test("rejects malformed catalog arrays instead of passing undefined to the UI", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(httpDatabaseApi.getDatabaseSchemas("app")).rejects.toThrow(
      "Invalid database schemas response.",
    );
    await expect(httpDatabaseApi.getDatabaseObjects("app", "public")).rejects.toThrow(
      "Invalid database objects response.",
    );
  });
});
