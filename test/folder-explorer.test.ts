import { describe, expect, test } from "vitest";
import { canOpenParentFolder } from "../src/web/client/src/features/git/folder-explorer";

describe("canOpenParentFolder", () => {
  test("shows parent navigation from the picker starting folder", () => {
    expect(
      canOpenParentFolder({
        parent: "/Users/roro/Downloads/work/Personal Project",
        path: "/Users/roro/Downloads/work/Personal Project/nomoreide",
      }),
    ).toBe(true);
  });

  test("hides parent navigation at the filesystem root", () => {
    expect(
      canOpenParentFolder({
        parent: "/",
        path: "/",
      }),
    ).toBe(false);
  });
});
