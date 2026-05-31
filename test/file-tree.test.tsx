import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { FileTree } from "../src/web/client/src/features/git/file-tree";

describe("FileTree", () => {
  test("can render every directory expanded by default", () => {
    const markup = renderToStaticMarkup(
      <FileTree
        defaultExpandAll
        onSelectFile={() => undefined}
        paths={["src/web/routes/agent-routes.ts"]}
        selectedFile="src/web/routes/agent-routes.ts"
        status={[
          {
            index: " ",
            path: "src/web/routes/agent-routes.ts",
            workingTree: "M",
          },
        ]}
      />,
    );

    expect(markup).toContain("agent-routes.ts");
  });

  test("renders expand and collapse all controls beside the branch badge", () => {
    const markup = renderToStaticMarkup(
      <FileTree
        branch="main"
        onSelectFile={() => undefined}
        paths={["src/web/routes/agent-routes.ts"]}
        selectedFile="src/web/routes/agent-routes.ts"
        status={[]}
        title="Changes"
      />,
    );

    expect(markup).toContain('aria-label="Expand all folders"');
    expect(markup).toContain('aria-label="Collapse all folders"');
    expect(markup.indexOf('aria-label="Collapse all folders"')).toBeLessThan(
      markup.indexOf(">main</span>"),
    );
  });
});
