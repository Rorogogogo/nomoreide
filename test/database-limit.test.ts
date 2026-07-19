import { describe, expect, test } from "vitest";
import { clampLimit } from "../src/core/db/driver.js";

describe("database result limits", () => {
  test("honors the full validated project preference range", () => {
    expect(clampLimit(5_000)).toBe(5_000);
    expect(clampLimit(5_001)).toBe(5_000);
  });
});
