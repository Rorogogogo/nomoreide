// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("legacy preference stores", () => {
  test("load safely when localStorage reads are denied", async () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    vi.resetModules();

    await expect(
      Promise.all([
        import("../apps/dashboard/src/lib/theme"),
        import("../apps/dashboard/src/lib/language"),
      ]),
    ).resolves.toBeDefined();
  });
});
