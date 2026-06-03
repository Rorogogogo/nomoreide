import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ChangedFilesList } from "../src/web/client/src/features/git/changed-files-list";

describe("ChangedFilesList", () => {
  test("renders changed files as a compact flat list instead of tree rows", () => {
    const markup = renderToStaticMarkup(
      <ChangedFilesList
        branch="main"
        files={[{ path: "src/app.tsx", index: " ", workingTree: "M" }]}
        onSelectFile={() => undefined}
        root="/repo"
        selectedFile="src/app.tsx"
      />,
    );

    expect(markup).toContain('aria-label="Open changed file src/app.tsx"');
    expect(markup).toContain("text-[12px]");
    expect(markup).toContain("py-0.5");
    expect(markup).toContain('data-testid="changed-file-name"');
    expect(markup).toContain('data-testid="changed-file-dir"');
    expect(markup).toContain(">app.tsx</span>");
    expect(markup).toContain(">src</span>");
    expect(markup).not.toContain("pl-5 text-[10px]");
  });

  test("truncates long branch names with a hover title", () => {
    const longBranch = "xwangrobert/ror-33-ai-native-agent-tools-plugins-workflows";
    const markup = renderToStaticMarkup(
      <ChangedFilesList
        branch={longBranch}
        files={[{ path: "src/app.tsx", index: " ", workingTree: "M" }]}
        onSelectFile={() => undefined}
        selectedFile="src/app.tsx"
      />,
    );

    expect(markup).toContain(`title="${longBranch}"`);
    expect(markup).toContain("max-w-40");
    expect(markup).toContain("truncate");
  });
});
