import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const root = resolve(__dirname, "..");
const appSource = readFileSync(resolve(root, "apps/dashboard/src/app.tsx"), "utf8");
const headerActionSource = readFileSync(
  resolve(root, "apps/dashboard/src/components/header-action.tsx"),
  "utf8",
);
const themeToggleSource = readFileSync(
  resolve(root, "apps/dashboard/src/components/theme-toggle.tsx"),
  "utf8",
);
const refreshButtonSource = readFileSync(
  resolve(root, "apps/dashboard/src/components/header-refresh-button.tsx"),
  "utf8",
);
const aiContextSource = readFileSync(
  resolve(root, "apps/dashboard/src/features/agent/ai-context-action.tsx"),
  "utf8",
);
const appContextMenuSource = readFileSync(
  resolve(root, "apps/dashboard/src/components/app-context-menu.tsx"),
  "utf8",
);
const aiContextMenuSource = readFileSync(
  resolve(root, "apps/dashboard/src/features/agent/context-menu/ai-context-menu.tsx"),
  "utf8",
);
// The Rust route module now, the TypeScript one having been deleted with the
// rest of the port's reference implementation. The assertion is unchanged in
// substance: no `/docs` route is served.
const shellRoutesSource = readFileSync(
  resolve(root, "crates/nomoreide-daemon/src/server/routes/shell.rs"),
  "utf8",
);
// UI copy now lives in the i18n catalog (t("...")), so rendered text is asserted
// against en.ts rather than the component source.
const catalog = readFileSync(
  resolve(root, "apps/dashboard/src/lib/i18n/en.ts"),
  "utf8",
);

describe("product header action dock", () => {
  test("groups refresh, theme, and docs as fixed-width icon controls", () => {
    expect(appSource).toContain('aria-label="Dashboard quick actions"');
    expect(appSource).toContain("headerActionClassName");
    expect(catalog).toContain("Refresh");
    expect(themeToggleSource).toContain("action.theme");
    expect(catalog).toContain("Docs");
  });

  test("header actions name themselves with a tooltip, not an inline label", () => {
    // The buttons used to widen on hover to reveal their label. That animated
    // three controls on every pass of the pointer; a tooltip says the same
    // thing without moving the header around.
    expect(headerActionSource).not.toContain("hover:w-24");
    expect(headerActionSource).not.toContain("headerActionLabelClassName");
    expect(themeToggleSource).toContain("<Tooltip");
    expect(refreshButtonSource).toContain("<Tooltip");
    expect(appSource).toContain('<Tooltip align="end" label={t("action.docs")}>');
  });

  test("keeps the quick-action dock height aligned with small header buttons", () => {
    expect(appSource).toContain('aria-label="Dashboard quick actions"');
    expect(headerActionSource).toContain("inline-flex size-7");
    expect(headerActionSource).toContain("flex size-7");
  });

  test("the refresh button reports the shared refresh cycle", () => {
    // The 5s poll runs through the same cycle as a click, so the icon is the
    // one place that answers "is this view current?".
    expect(appSource).toContain("runRefreshCycle");
    expect(appSource).toContain("void runRefreshCycle()");
    expect(refreshButtonSource).toContain("animate-spin");
    expect(refreshButtonSource).toContain("<Check");
    expect(catalog).toContain('"action.refreshing"');
    expect(catalog).toContain('"action.refreshedJustNow"');
  });

  test("adds global AI context menus for services, databases, errors, and git", () => {
    expect(appSource).toContain("<AiContextMenuProvider>");
    expect(appSource).toContain("<AppContextMenu onRefresh={refreshAll}>");
    expect(appContextMenuSource).toContain("useOptionalAiContextMenuRegistry");
    expect(appContextMenuSource).toContain("deliverAiIntent");
    expect(appContextMenuSource).toContain("sendToAgent");
    expect(aiContextMenuSource).toContain("AiContextTarget");
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
