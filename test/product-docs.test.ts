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
const aiContextSource = readFileSync(
  resolve(root, "src/web/client/src/features/agent/ai-context-action.tsx"),
  "utf8",
);
const shellRoutesSource = readFileSync(
  resolve(root, "src/web/routes/shell-routes.ts"),
  "utf8",
);
// UI copy now lives in the i18n catalog (t("...")), so rendered text is asserted
// against en.ts rather than the component source.
const catalog = readFileSync(
  resolve(root, "src/web/client/src/lib/i18n/en.ts"),
  "utf8",
);

describe("product header action dock", () => {
  test("groups refresh, theme, and docs as expandable icon-first controls", () => {
    expect(appSource).toContain('aria-label="Dashboard quick actions"');
    expect(appSource).toContain("headerActionClassName");
    expect(appSource).toContain("headerActionLabelClassName");
    expect(appSource).toContain("Refresh");
    expect(themeToggleSource).toContain("Theme");
    expect(catalog).toContain("Docs");
    expect(headerActionSource).toContain("hover:w-24");
    expect(headerActionSource).toContain("focus-visible:w-24");
  });

  test("keeps header action labels expanded after mouse click focus", () => {
    expect(headerActionSource).toContain("focus:w-24");
    expect(headerActionSource).toContain("group-focus/header-action:max-w-20");
  });

  test("keeps the quick-action dock height aligned with small header buttons", () => {
    expect(appSource).toContain("rounded-lg border border-border bg-background p-px");
    expect(headerActionSource).toContain("inline-flex h-7 w-7");
    expect(headerActionSource).toContain("text-xs");
    expect(headerActionSource).toContain("flex size-7");
  });

  test("adds a global AI context action for services, databases, errors, and git", () => {
    expect(appSource).toContain("<AiContextAction");
    expect(appSource).toContain("data={data}");
    expect(catalog).toContain("AI Diagnose");
    expect(catalog).toContain("Diagnose");
    expect(aiContextSource).toContain('size="xl"');
    expect(catalog).toContain("Services");
    expect(aiContextSource).toContain("Databases");
    expect(catalog).toContain("Error Inbox");
    expect(catalog).toContain("Git Repositories");
    expect(aiContextSource).toContain("repositoryPaths");
    expect(aiContextSource).toContain("lg:grid-cols-4");
    expect(aiContextSource).toContain("max-h-[min(520px,calc(100vh-18rem))]");
    expect(aiContextSource).toContain("flex-1 overflow-auto");
    expect(aiContextSource).toContain("block min-w-0 truncate font-mono");
    expect(aiContextSource).toContain("listDatabases");
    expect(aiContextSource).toContain("getErrorIncidents");
    expect(aiContextSource).toContain("buildAiContextPrompt");
    expect(aiContextSource).toContain("buildAiContextLabel");
    expect(aiContextSource).toContain("sendToAgent");
  });

  test("adds a simple docs button to the local dashboard header", () => {
    expect(appSource).toContain('href="https://www.nomoreide.com/docs"');
    expect(appSource).toContain('aria-label={t("action.docsTitle")}');
    expect(appSource).toContain('title={t("action.docsTitle")}');
    expect(catalog).toContain("Open NoMoreIDE documentation");
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
