import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const themeToggleSource = readFileSync(
  resolve(__dirname, "../src/web/client/src/components/theme-toggle.tsx"),
  "utf8",
);
const productHtml = readFileSync(
  resolve(__dirname, "../src/web/client/index.html"),
  "utf8",
);
const websiteHtml = readFileSync(resolve(__dirname, "../website/index.html"), "utf8");

describe("default theme", () => {
  test("defaults the product theme to dark when no preference is saved", () => {
    expect(themeToggleSource).toContain('const STORAGE_KEY = "nomoreide-theme-choice";');
    expect(themeToggleSource).toContain('if (typeof window === "undefined") return "dark";');
    expect(themeToggleSource).toContain('return "dark";');
    expect(themeToggleSource).not.toContain("prefers-color-scheme: dark");
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
