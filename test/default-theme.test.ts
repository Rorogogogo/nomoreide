import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

// The storage key + dark default live in the shared theme store (used by the
// header toggle and the Settings page).
const themeStoreSource = readFileSync(
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
    expect(themeStoreSource).toContain('const STORAGE_KEY = "nomoreide-theme-choice";');
    expect(themeStoreSource).toContain('if (typeof window === "undefined") return "dark";');
    expect(themeStoreSource).toContain('return "dark";');
    expect(themeStoreSource).not.toContain("prefers-color-scheme: dark");
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
