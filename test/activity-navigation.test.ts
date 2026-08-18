import { describe, expect, test } from "vitest";
import { pageFromPath } from "../src/web/client/src/app";

describe("activity navigation", () => {
  test("recognizes the Activity Monitor route without prefix overmatching", () => {
    expect(pageFromPath("/activity")).toBe("activity");
    // Unrecognised paths fall back to Home, which is what "/" means now that
    // Services has moved to a path of its own.
    expect(pageFromPath("/activity/details")).toBe("home");
    expect(pageFromPath("/activity-old")).toBe("home");
  });

  test("Home owns the root and Services has its own path", () => {
    expect(pageFromPath("/")).toBe("home");
    expect(pageFromPath("/services")).toBe("services");
  });

  test("does not expose the removed terminal page", () => {
    expect(pageFromPath("/terminal")).toBe("home");
  });
});
