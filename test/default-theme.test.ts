import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

// The storage key + dark default live in the shared theme store (used by the
// header toggle and the Settings page).
const themeStoreSource = readFileSync(
  resolve(__dirname, "../apps/dashboard/src/lib/theme.ts"),
  "utf8",
);
const productHtml = readFileSync(
  resolve(__dirname, "../apps/dashboard/index.html"),
  "utf8",
);
const websiteHtml = readFileSync(resolve(__dirname, "../website/index.html"), "utf8");

describe("default theme", () => {
  test("models system as a first-class product theme", () => {
    expect(themeStoreSource).toContain('const STORAGE_KEY = "nomoreide-theme-choice";');
    expect(themeStoreSource).toContain('export type Theme = "light" | "dark" | "system";');
    expect(themeStoreSource).toContain("prefers-color-scheme: dark");
  });

  test("boots the product's canonical appearance before React renders", () => {
    expect(productHtml).toContain('window.localStorage.getItem("nomoreide:ui-preferences")');
    expect(productHtml).toContain('window.localStorage.getItem("nomoreide-theme-choice")');
    expect(productHtml).toContain("stored?.version === 1 || stored?.version === 2");
    expect(productHtml).toContain("prefers-color-scheme: dark");
    expect(productHtml).toContain("dataset.density");
    expect(productHtml).toContain("dataset.reducedMotion");
    expect(productHtml).toContain('style.setProperty("--code-font-size"');
  });

  test("keeps the standalone website's existing dark bootstrap", () => {
    expect(websiteHtml).toContain('<html lang="en" class="dark" style="color-scheme: dark">');
    expect(websiteHtml).toContain('window.localStorage.getItem("nomoreide-theme-choice")');
    expect(websiteHtml).not.toContain('window.localStorage.getItem("nomoreide-theme")');
  });
});
