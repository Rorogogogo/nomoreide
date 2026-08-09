// @vitest-environment happy-dom

import { describe, expect, test, vi } from "vitest";
import {
  installWebsiteMockApi,
  getWebsiteMockDatabaseRows,
  getWebsiteMockDatabaseTables,
} from "../website/src/mock-api";

describe("website mock database", () => {
  test("exposes a richer set of demo tables", () => {
    const tables = getWebsiteMockDatabaseTables();

    expect(tables.map((table) => table.qualifiedName)).toEqual([
      "public.users",
      "public.projects",
      "public.subscriptions",
      "public.usage_events",
      "public.agent_runs",
      "public.service_health",
      "billing.invoices",
    ]);
  });

  test("returns table-specific paginated row samples", () => {
    const firstPage = getWebsiteMockDatabaseRows("public.projects", 2, 0);
    const secondPage = getWebsiteMockDatabaseRows("public.projects", 2, 2);
    const events = getWebsiteMockDatabaseRows("public.usage_events", 10, 0);

    expect(firstPage.table.qualifiedName).toBe("public.projects");
    expect(firstPage.columns.map((column) => column.name)).toContain("repository");
    expect(firstPage.rows).toHaveLength(2);
    expect(firstPage.rowCount).toBeGreaterThan(2);
    expect(firstPage.limit).toBe(2);
    expect(firstPage.offset).toBe(0);
    expect(secondPage.rows[0]).not.toEqual(firstPage.rows[0]);
    expect(events.columns.map((column) => column.name)).toContain("metadata");
    expect(events.rows.some((row) => typeof row.metadata === "object")).toBe(true);
  });

  test("serves the complete catalog API used by DatabaseExplorer", async () => {
    window.fetch = vi.fn(async () => new Response(null, { status: 404 }));
    installWebsiteMockApi();

    const capabilities = await window.fetch(
      "/api/databases/acme-local/catalog/capabilities",
    ).then((response) => response.json());
    const schemas = await window.fetch(
      "/api/databases/acme-local/catalog/schemas",
    ).then((response) => response.json());
    const objects = await window.fetch(
      "/api/databases/acme-local/catalog/objects?schema=public",
    ).then((response) => response.json());
    const details = await window.fetch(
      "/api/databases/acme-local/catalog/details?key=public.users",
    ).then((response) => response.json());
    const rows = await window.fetch(
      "/api/databases/acme-local/catalog/rows?key=public.users&limit=2&offset=0",
    ).then((response) => response.json());

    expect(capabilities.capabilities.objectKinds).toContain("table");
    expect(schemas.schemas).toEqual([{ name: "public" }, { name: "billing" }]);
    expect(objects.objects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "public.users", kind: "table" }),
      ]),
    );
    expect(details.details).toMatchObject({
      object: { qualifiedName: "public.users" },
      columns: expect.any(Array),
    });
    expect(rows).toMatchObject({
      ok: true,
      object: { qualifiedName: "public.users" },
      rowCount: 3,
    });
  });
});
