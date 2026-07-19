import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const source = readFileSync(
  resolve(__dirname, "../src/web/client/src/features/git/largest-files-view.tsx"),
  "utf8",
);
// UI copy now lives in the i18n catalog (t("...")).
const catalog = readFileSync(
  resolve(__dirname, "../src/web/client/src/lib/i18n/en.ts"),
  "utf8",
);

describe("LargestFilesView row actions", () => {
  test("splits large-file row actions into AI and copy popovers", () => {
    expect(source).toContain("LargeFileAiMenu");
    expect(source).toContain("LargeFileCopyMenu");
    expect(catalog).toContain("Ask AI to split this file");
    expect(catalog).toContain("Send file path to AI");
    expect(catalog).toContain("Copy absolute path");
    expect(source).toContain("MoreHorizontal");
    expect(source).not.toContain("Sparkles");
  });
});
