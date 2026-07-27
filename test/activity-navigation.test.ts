import { describe, expect, test } from "vitest";
import { pageFromPath } from "../src/web/client/src/app";

describe("activity navigation", () => {
  test("recognizes the Activity Monitor route without prefix overmatching", () => {
    expect(pageFromPath("/activity")).toBe("activity");
    expect(pageFromPath("/activity/details")).toBe("services");
    expect(pageFromPath("/activity-old")).toBe("services");
  });
});
