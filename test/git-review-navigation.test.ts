import { describe, expect, test } from "vitest";
import { nextChangeDecision } from "../apps/dashboard/src/features/git/review-navigation";

describe("nextChangeDecision", () => {
  test("moves to the next hunk inside the current file", () => {
    expect(
      nextChangeDecision({
        activeHunkIndex: 0,
        filePaths: ["a.ts", "b.ts"],
        hunkCount: 2,
        pendingNextFilePath: null,
        selectedFile: "a.ts",
      }),
    ).toEqual({ kind: "hunk", activeHunkIndex: 1 });
  });

  test("asks for confirmation before moving from the last hunk to the next file", () => {
    expect(
      nextChangeDecision({
        activeHunkIndex: 0,
        filePaths: ["a.ts", "b.ts"],
        hunkCount: 1,
        pendingNextFilePath: null,
        selectedFile: "a.ts",
      }),
    ).toEqual({ kind: "confirm-next-file", filePath: "b.ts" });
  });

  test("moves to the pending next file on the second click", () => {
    expect(
      nextChangeDecision({
        activeHunkIndex: 0,
        filePaths: ["a.ts", "b.ts"],
        hunkCount: 1,
        pendingNextFilePath: "b.ts",
        selectedFile: "a.ts",
      }),
    ).toEqual({ kind: "file", filePath: "b.ts" });
  });
});
