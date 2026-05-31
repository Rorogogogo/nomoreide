import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const root = resolve(__dirname, "..");
const appSource = readFileSync(resolve(root, "src/web/client/src/app.tsx"), "utf8");
const shellRoutesSource = readFileSync(
  resolve(root, "src/web/routes/shell-routes.ts"),
  "utf8",
);

describe("product docs button", () => {
  test("adds a simple docs button to the local dashboard header", () => {
    expect(appSource).toContain('href="https://www.nomoreide.com/docs"');
    expect(appSource).toContain('title="Open NoMoreIDE documentation"');
    expect(appSource).toContain("BookOpen");
  });

  test("does not add a dedicated product docs page or sidebar route", () => {
    expect(appSource).not.toContain('window.location.pathname.startsWith("/docs")');
    expect(appSource).not.toContain('label="Docs"');
    expect(appSource).not.toContain("DocsView");
    expect(appSource).not.toContain('page === "docs"');
    expect(shellRoutesSource).not.toContain('"/docs"');
  });
});
