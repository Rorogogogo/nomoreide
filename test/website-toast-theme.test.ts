import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const css = readFileSync(resolve(__dirname, "../website/src/index.css"), "utf8");

describe("website embedded app toast theme", () => {
  test("defines dashboard toast tokens at the page root", () => {
    expect(css).toContain("--color-contrast-fg: var(--ds-contrast-fg)");
    expect(css).toContain("--color-gray-1000: var(--ds-gray-1000)");
    expect(css).toContain("--color-geist-background: var(--geist-background)");
    expect(css).toContain("--shadow-menu: var(--ds-shadow-menu)");
    expect(css).toContain("--ds-blue-700:");
    expect(css).toContain("--ds-gray-1000:");
    expect(css).toContain("--ds-shadow-menu:");
  });

  test("gives the embedded dashboard its own dark theme tokens", () => {
    expect(css).toContain(".dark .website-real-demo");
    expect(css).toContain("--background: 24 10% 6%");
    expect(css).toContain("--foreground: 0 0% 95%");
    expect(css).toContain("--card: 24 10% 9%");
    expect(css).toContain("--accent: 170 34% 45%");
    expect(css).toContain("--ds-background-100: hsla(0, 0%, 4%, 1)");
  });

  test("keeps transparent dashboard borders transparent inside the mock", () => {
    expect(css).toMatch(
      /\.website-real-demo \.border-transparent\s*\{\s*border-color: transparent;/,
    );
  });

  test("lets the workbench fill the demo frame without centered side gutters", () => {
    expect(css).toMatch(
      /\.website-real-demo \[data-workbench-shell\]\s*\{\s*max-width: none;/,
    );
  });

  test("does not draw a second outline around scaled terminal viewports", () => {
    expect(css).toContain('.website-real-demo [aria-label="terminal viewport"]');
    expect(css).toContain(".website-real-demo .xterm-viewport");
    expect(css).toMatch(/\.website-real-demo \.xterm-screen\s*\{[^}]*border: 0;/s);
  });

  test("uses a website-only Claude image instead of terminal block art", () => {
    expect(css).toContain('[data-terminal-session="demo-claude-agent"]');
    expect(css).toContain('background: url("./assets/claude-mark.svg")');
    expect(css).toContain('[data-terminal-follow-up="true"]');
  });
});
