import { describe, expect, test } from "vitest";
import {
  buildDiffRows,
  diffPath,
  diffStats,
  highlightDiffRows,
  visibleDiffRows,
} from "../apps/dashboard/src/features/git/diff-viewer";

describe("buildDiffRows", () => {
  test("tracks old and new line numbers across unified diff rows", () => {
    const rows = buildDiffRows(
      [
        "diff --git a/README.md b/README.md",
        "--- a/README.md",
        "+++ b/README.md",
        "@@ -2,3 +2,4 @@",
        " context",
        "-old",
        "+new",
        "+added",
        " next",
      ].join("\n"),
    );

    expect(rows.map(({ kind, oldLine, newLine }) => ({ kind, oldLine, newLine }))).toEqual([
      { kind: "meta", oldLine: null, newLine: null },
      { kind: "meta", oldLine: null, newLine: null },
      { kind: "meta", oldLine: null, newLine: null },
      { kind: "hunk", oldLine: null, newLine: null },
      { kind: "context", oldLine: 2, newLine: 2 },
      { kind: "delete", oldLine: 3, newLine: null },
      { kind: "add", oldLine: null, newLine: 3 },
      { kind: "add", oldLine: null, newLine: 4 },
      { kind: "context", oldLine: 4, newLine: 5 },
    ]);
  });

  test("resets numbering at each hunk", () => {
    const rows = buildDiffRows(
      [
        "@@ -1 +1 @@",
        "-before",
        "+after",
        "@@ -20 +30 @@",
        " later",
      ].join("\n"),
    );

    expect(rows[1]).toMatchObject({ kind: "delete", oldLine: 1, newLine: null });
    expect(rows[2]).toMatchObject({ kind: "add", oldLine: null, newLine: 1 });
    expect(rows[4]).toMatchObject({ kind: "context", oldLine: 20, newLine: 30 });
  });

  test("does not carry line numbers into the next file header", () => {
    const rows = buildDiffRows(
      [
        "diff --git a/a.txt b/a.txt",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "diff --git a/b.txt b/b.txt",
        "index 1111111..2222222 100644",
        "--- a/b.txt",
        "+++ b/b.txt",
        "@@ -10 +10 @@",
        " c",
      ].join("\n"),
    );

    expect(rows[4]).toMatchObject({ kind: "meta", oldLine: null, newLine: null });
    expect(rows[5]).toMatchObject({ kind: "meta", oldLine: null, newLine: null });
    expect(rows[9]).toMatchObject({ kind: "context", oldLine: 10, newLine: 10 });
  });

  test("hides raw git metadata and hunk header rows", () => {
    const rows = visibleDiffRows(
      [
        "diff --git a/a.txt b/a.txt",
        "index 1111111..2222222 100644",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n"),
    );

    expect(rows.map((row) => row.content)).toEqual(["-old", "+new"]);
  });

  test("keeps hunk indexes on visible rows for scroll targets", () => {
    const rows = visibleDiffRows(
      [
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "@@ -20 +20 @@",
        "-later",
        "+next",
      ].join("\n"),
    );

    expect(rows.map(({ content, hunkIndex }) => ({ content, hunkIndex }))).toEqual([
      { content: "-old", hunkIndex: 0 },
      { content: "+new", hunkIndex: 0 },
      { content: "-later", hunkIndex: 1 },
      { content: "+next", hunkIndex: 1 },
    ]);
  });

  test("keeps plain non-diff messages visible", () => {
    expect(visibleDiffRows("No unstaged diff for this file.")).toEqual([
      {
        content: "No unstaged diff for this file.",
        hunkIndex: null,
        kind: "meta",
        oldLine: null,
        newLine: null,
      },
    ]);
  });

  test("counts additions, deletions, and hunks", () => {
    expect(
      diffStats(
        [
          "diff --git a/a.txt b/a.txt",
          "--- a/a.txt",
          "+++ b/a.txt",
          "@@ -1,2 +1,3 @@",
          "-old",
          "+new",
          "+added",
          " context",
          "@@ -10 +11 @@",
          "-removed",
        ].join("\n"),
      ),
    ).toEqual({
      additions: 2,
      deletions: 2,
      hunks: 2,
    });
  });
});

describe("highlightDiffRows", () => {
  const diff = [
    "diff --git a/src/old.ts b/src/app.ts",
    "--- a/src/old.ts",
    "+++ b/src/app.ts",
    "@@ -1,2 +1,2 @@",
    " const a = 1",
    "-const b = '<two>'",
    "+const b = 3",
  ].join("\n");

  test("reads the file a diff is of from its own header, the new name of a rename", () => {
    expect(diffPath(diff)).toBe("src/app.ts");
    expect(diffPath("@@ -1 +1 @@\n-a\n+b")).toBe("");
    expect(diffPath("No unstaged diff")).toBe("");
  });

  test("colours each line of code without its mark, and escapes what it holds", () => {
    const rows = visibleDiffRows(diff);
    const html = highlightDiffRows(rows, "typescript");

    expect(html).toHaveLength(rows.length);
    expect(html[0]).toContain('<span class="hljs-keyword">const</span>');
    expect(html[2]).toContain('<span class="hljs-number">3</span>');
    // The leading +, - or space is the diff's, not the code's.
    expect(html[2]?.startsWith("+")).toBe(false);
    // A line is escaped before it is marked up: its own angle brackets stay text.
    expect(html[1]).toContain("&lt;two&gt;");
    expect(html[1]).not.toContain("<two>");
  });

  test("leaves a file of no known language, and rows that are not code, uncoloured", () => {
    const rows = buildDiffRows(diff);

    expect(highlightDiffRows(rows, null).every((row) => row === null)).toBe(true);
    const html = highlightDiffRows(rows, "typescript");
    expect(html.slice(0, 4)).toEqual([null, null, null, null]);
    expect(html[4]).not.toBeNull();
  });
});
