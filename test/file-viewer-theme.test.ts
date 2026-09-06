import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

// The viewer's chrome and the highlighted text it wraps are two modules now.
// These assertions are about what the viewer renders, so they read both.
const fileViewerSource = ["file-viewer.tsx", "file-viewer-content.tsx"]
  .map((file) =>
    readFileSync(
      resolve(__dirname, `../apps/dashboard/src/features/git/${file}`),
      "utf8",
    ),
  )
  .join("\n");

describe("file viewer theme", () => {
  test("keeps the tracked-file source view dark in dark mode", () => {
    // The container uses the `bg-card` theme token, and the code itself keeps
    // an explicit light-on-dark accent so highlighting stays readable.
    expect(fileViewerSource).toContain("bg-card");
    expect(fileViewerSource).toContain("dark:text-zinc-100");
  });

  /**
   * The gutter is set apart by alignment and contrast, not by a rule.
   *
   * This used to assert `dark:bg-zinc-900` and `dark:border-zinc-800` — a slab
   * behind the numbers *and* a border beside them, two devices doing one job.
   * At this type size the pair read as a scrollbar rather than as line numbers.
   * Those assertions are gone on purpose rather than by accident, and this
   * replaces them so the rule cannot quietly return.
   */
  test("draws no rule or slab behind the line numbers", () => {
    expect(fileViewerSource).not.toContain("border-r");
    expect(fileViewerSource).not.toContain("bg-zinc-100");
    expect(fileViewerSource).not.toContain("dark:bg-zinc-900");
  });
});
