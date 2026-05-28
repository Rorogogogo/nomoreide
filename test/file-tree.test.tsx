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
});
