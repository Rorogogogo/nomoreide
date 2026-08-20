import { describe, expect, test } from "vitest";
import * as editor from "../apps/dashboard/src/features/git/code-editor";

describe("code editor helpers", () => {
  test("detects TypeScript React files", () => {
    expect(editor.editorLanguageNameForPath("src/app.tsx")).toBe("typescriptreact");
  });

  test("does not expose custom snippet completions", () => {
    expect(editor).not.toHaveProperty("snippetLabelsForPath");
  });
});
