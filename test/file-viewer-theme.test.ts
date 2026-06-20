import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const fileViewerSource = readFileSync(
  resolve(__dirname, "../src/web/client/src/features/git/file-viewer.tsx"),
  "utf8",
);

describe("file viewer theme", () => {
  test("keeps the tracked-file source view dark in dark mode", () => {
    // The container now uses the `bg-card` theme token (dark in dark mode);
    // the gutter/code keep explicit zinc accents.
    expect(fileViewerSource).toContain("bg-card");
    expect(fileViewerSource).toContain("dark:bg-zinc-900");
    expect(fileViewerSource).toContain("dark:border-zinc-800");
    expect(fileViewerSource).toContain("dark:text-zinc-100");
  });
});
