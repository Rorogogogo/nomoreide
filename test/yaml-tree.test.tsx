import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { YamlTree } from "../src/web/client/src/features/git/visualizers/yaml-tree";

describe("YamlTree", () => {
  test("renders every nested container expanded by default", () => {
    const markup = renderToStaticMarkup(
      <YamlTree
        content={`services:
  api:
    environment:
      database:
        host: localhost
`}
      />,
    );

    expect(markup).not.toContain('aria-expanded="false"');
    expect(markup.match(/aria-expanded="true"/g)).toHaveLength(4);
    expect(markup).toContain("localhost");
  });
});
