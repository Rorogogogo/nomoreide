import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const root = resolve(__dirname, "..");
const appSource = readFileSync(resolve(root, "src/web/client/src/app.tsx"), "utf8");
const shellRoutesSource = readFileSync(
  resolve(root, "src/web/routes/shell-routes.ts"),
  "utf8",
);
const docsViewSource = readFileSync(
  resolve(root, "src/web/client/src/features/docs/docs-view.tsx"),
  "utf8",
);

describe("product docs page", () => {
  test("adds Docs to the local dashboard navigation and route sync", () => {
    expect(appSource).toContain('"docs"');
    expect(appSource).toContain('window.location.pathname.startsWith("/docs")');
    expect(appSource).toContain('label="Docs"');
    expect(appSource).toContain("DocsView");
    expect(appSource).toContain('page === "docs"');
  });

  test("serves /docs from the local dashboard shell", () => {
    expect(shellRoutesSource).toContain('"/docs"');
  });

  test("points users and agents to the public docs and AI-fetchable files", () => {
    expect(docsViewSource).toContain("https://www.nomoreide.com/docs");
    expect(docsViewSource).toContain("https://www.nomoreide.com/llms.txt");
    expect(docsViewSource).toContain("https://www.nomoreide.com/llms-full.txt");
    expect(docsViewSource).toContain("https://www.nomoreide.com/docs/ai-guide.md");
  });
});
