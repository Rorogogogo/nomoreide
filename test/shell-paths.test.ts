import { describe, expect, test } from "vitest";
import { PAGE_PATHS } from "../src/web/client/src/app";
import { shellPaths } from "../src/web/routes/shell-routes";

describe("SPA shell paths", () => {
  test("serves every client route on direct load", () => {
    const missing = Object.entries(PAGE_PATHS)
      .filter(([, path]) => !shellPaths.has(path))
      .map(([page, path]) => `${page} (${path})`);

    expect(
      missing,
      `Add these to shellPaths in src/web/routes/shell-routes.ts, or loading them directly 404s: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  test("has no shell path the client cannot route", () => {
    const clientPaths = new Set(Object.values(PAGE_PATHS));
    const orphaned = [...shellPaths].filter((path) => !clientPaths.has(path));

    expect(orphaned).toEqual([]);
  });
});
