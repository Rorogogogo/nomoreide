import { describe, expect, test } from "vitest";
import {
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
});
