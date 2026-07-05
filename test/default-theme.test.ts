import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

// The light/dark preference now lives in the shared theme hook module.
const themeSource = readFileSync(
  resolve(__dirname, "../src/web/client/src/lib/theme.ts"),
  "utf8",
);
const productHtml = readFileSync(
  resolve(__dirname, "../src/web/client/index.html"),
  "utf8",
);
const websiteHtml = readFileSync(resolve(__dirname, "../website/index.html"), "utf8");

describe("default theme", () => {
  test("defaults the product theme to dark when no preference is saved", () => {
    expect(themeSource).toContain('export const THEME_STORAGE_KEY = "nomoreide-theme-choice";');
    expect(themeSource).toContain('if (typeof window === "undefined") return "dark";');
    expect(themeSource).toContain('return "dark";');
    expect(themeSource).not.toContain("prefers-color-scheme: dark");
  });

  test("boots both HTML shells in dark mode before React renders", () => {
    for (const html of [productHtml, websiteHtml]) {
      expect(html).toContain('<html lang="en" class="dark" style="color-scheme: dark">');
      expect(html).toContain('window.localStorage.getItem("nomoreide-theme-choice")');
      expect(html).toContain('const theme = stored === "light" ? "light" : "dark";');
      expect(html).toContain('document.documentElement.classList.toggle("dark", theme === "dark");');
      expect(html).not.toContain('window.localStorage.getItem("nomoreide-theme")');
    }
  });
});
