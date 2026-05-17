import { describe, expect, test } from "vitest";
import { fileIconKind } from "../src/web/client/src/features/git/file-icon-kind";

describe("fileIconKind", () => {
  test.each([
    ["src/index.ts", "code"],
    ["src/app.test.tsx", "test"],
    ["README.md", "document"],
    ["src/styles.css", "style"],
    ["package.json", "config"],
    ["package-lock.json", "lock"],
    ["data/events.csv", "data"],
    ["assets/logo.svg", "image"],
    ["unknown.bin", "generic"],
  ] as const)("classifies %s as %s", (path, kind) => {
    expect(fileIconKind(path)).toBe(kind);
  });
});
