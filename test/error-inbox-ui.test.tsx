import { describe, expect, test } from "vitest";
import {
  activeIncidentFilterCount,
  filterIncidents,
  incidentFilterOptions,
  incidentMatchesQuery,
  type IncidentFilters,
} from "../src/web/client/src/features/errors/incident-filters";
import type { ErrorIncident } from "../src/web/client/src/lib/api";

function incident(overrides: Partial<ErrorIncident> & Pick<ErrorIncident, "id">): ErrorIncident {
  return {
    id: overrides.id,
    service: "api",
    level: "error",
    signature: `signature-${overrides.id}`,
    title: "Database connection failed",
    file: "/workspace/src/database.ts",
    line: 42,
    firstSeen: "2026-07-20T00:00:00.000Z",
    lastSeen: "2026-07-20T00:05:00.000Z",
    count: 3,
    logExcerpt: ["Error: ECONNREFUSED", "at connect (/workspace/src/database.ts:42:1)"],
    ...overrides,
  };
}

const incidents = [
  incident({ id: 3, service: "web", title: "Checkout render warning", level: "warning", file: "/app/checkout.tsx", logExcerpt: ["Hydration mismatch"] }),
  incident({ id: 2, service: "worker", title: "Queue stalled", file: "/app/jobs.ts", logExcerpt: ["Redis timeout"] }),
  incident({ id: 1 }),
];

const noFilters: IncidentFilters = { levels: [], services: [] };

describe("Error Inbox incident filtering", () => {
  test("searches service, title, file, and excerpts case-insensitively", () => {
    expect(filterIncidents(incidents, "WEB", noFilters).map(({ id }) => id)).toEqual([3]);
    expect(filterIncidents(incidents, "queue STALLED", noFilters).map(({ id }) => id)).toEqual([2]);
    expect(filterIncidents(incidents, "CHECKOUT.TSX", noFilters).map(({ id }) => id)).toEqual([3]);
    expect(filterIncidents(incidents, "redis TIMEOUT", noFilters).map(({ id }) => id)).toEqual([2]);
    expect(incidentMatchesQuery(incidents[0], "  hydration mismatch  ")).toBe(true);
  });

  test("intersects filter categories and unions values within a category", () => {
    expect(
      filterIncidents(incidents, "", {
        levels: ["error", "warning"],
        services: ["api", "web"],
      }).map(({ id }) => id),
    ).toEqual([3, 1]);
    expect(
      filterIncidents(incidents, "", {
        levels: ["error"],
        services: ["worker"],
      }).map(({ id }) => id),
    ).toEqual([2]);
  });

  test("preserves the incoming newest-first order", () => {
    expect(filterIncidents(incidents, "", noFilters).map(({ id }) => id)).toEqual([3, 2, 1]);
    expect(filterIncidents(incidents, "", { levels: ["error"], services: [] }).map(({ id }) => id)).toEqual([2, 1]);
  });

  test("counts selected filter values and returns unique sorted options", () => {
    const filters: IncidentFilters = {
      levels: ["warning", "error"],
      services: ["worker", "api"],
    };

    expect(activeIncidentFilterCount(filters)).toBe(4);
    expect(activeIncidentFilterCount(noFilters)).toBe(0);
    expect(incidentFilterOptions(incidents)).toEqual({
      levels: ["error", "warning"],
      services: ["api", "web", "worker"],
    });
  });
});
