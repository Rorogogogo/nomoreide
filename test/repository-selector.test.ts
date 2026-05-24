import { describe, expect, test } from "vitest";
import { repositoryPickerState } from "../src/web/client/src/features/git/repository-selector";

describe("repository picker state", () => {
  test("starts browse-add from the current git cwd instead of the typed path", () => {
    expect(
      repositoryPickerState({
        gitCwd: "/repo/current",
        typedPath: "/definitely/not/a/valid/folder",
      }),
    ).toEqual({
      confirmLabel: "Add Git project",
      initialPath: "/repo/current",
      selectedPath: "/repo/current",
    });
  });
});
