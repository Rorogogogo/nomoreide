import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const root = resolve(__dirname, "..");
const appSource = readFileSync(resolve(root, "src/web/client/src/app.tsx"), "utf8");
const headerActionSource = readFileSync(
  resolve(root, "src/web/client/src/components/header-action.tsx"),
  "utf8",
);
const themeToggleSource = readFileSync(
  resolve(root, "src/web/client/src/components/theme-toggle.tsx"),
  "utf8",
);
const shellRoutesSource = readFileSync(
  resolve(root, "src/web/routes/shell-routes.ts"),
  "utf8",
);

describe("product header action dock", () => {
  test("groups refresh, theme, and docs as expandable icon-first controls", () => {
    expect(appSource).toContain('aria-label="Dashboard quick actions"');
    expect(appSource).toContain("headerActionClassName");
    expect(appSource).toContain("headerActionLabelClassName");
    expect(appSource).toContain("Refresh");
    expect(themeToggleSource).toContain("Theme");
    expect(appSource).toContain("Docs");
    expect(headerActionSource).toContain("hover:w-24");
    expect(headerActionSource).toContain("focus-visible:w-24");
  });

  test("adds a simple docs button to the local dashboard header", () => {
    expect(appSource).toContain('href="https://www.nomoreide.com/docs"');
    expect(appSource).toContain('aria-label="Open NoMoreIDE documentation"');
    expect(appSource).toContain('title="Open NoMoreIDE documentation"');
    expect(appSource).toContain("<ThemeToggle />");
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
