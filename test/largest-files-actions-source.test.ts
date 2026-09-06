import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { catalogSource } from "./support/i18n-source";

const source = readFileSync(
  resolve(__dirname, "../apps/dashboard/src/features/git/largest-files-view.tsx"),
  "utf8",
);
// UI copy now lives in the i18n catalog (t("...")).
const catalog = catalogSource("en");

describe("LargestFilesView row actions", () => {
  test("moves AI actions to the context menu and keeps the copy popover", () => {
    expect(source).toContain("<AiContextTarget");
    expect(source).toContain('id: "split-large-file"');
    expect(source).toContain('id: "inspect-large-file"');
    expect(source).toContain("LargeFileCopyMenu");
    expect(catalog).toContain("Ask AI to split this file");
    expect(catalog).toContain("Send file path to AI");
    expect(catalog).toContain("Copy absolute path");
    expect(source).toContain("MoreHorizontal");
    expect(source).not.toContain("LargeFileAiMenu");
  });
});
