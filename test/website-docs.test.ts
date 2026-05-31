import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const root = resolve(__dirname, "..");
const appSource = readFileSync(resolve(root, "website/src/App.tsx"), "utf8");
const heroSource = readFileSync(
  resolve(root, "website/src/components/hero.tsx"),
  "utf8",
);
const ctaSource = readFileSync(
  resolve(root, "website/src/components/cta.tsx"),
  "utf8",
);
const footerSource = readFileSync(
  resolve(root, "website/src/components/footer.tsx"),
  "utf8",
);

describe("website docs", () => {
  test("routes /docs to the documentation page", () => {
    expect(appSource).toContain("DocsPage");
    expect(appSource).toContain('window.location.pathname === "/docs"');
  });

  test("links the landing page to /docs without replacing the live mock link", () => {
    expect(heroSource).toContain('href="#hero-demo"');
    expect(heroSource).toContain('href="/docs"');
    expect(ctaSource).toContain('href="/docs"');
    expect(footerSource).toContain('href="/docs"');
  });

  test("publishes AI-fetchable documentation assets", () => {
    const llmsPath = resolve(root, "website/public/llms.txt");
    const fullPath = resolve(root, "website/public/llms-full.txt");
    const aiGuidePath = resolve(root, "website/public/docs/ai-guide.md");

    expect(existsSync(llmsPath)).toBe(true);
    expect(existsSync(fullPath)).toBe(true);
    expect(existsSync(aiGuidePath)).toBe(true);

    const llms = readFileSync(llmsPath, "utf8");
    const full = readFileSync(fullPath, "utf8");
    const aiGuide = readFileSync(aiGuidePath, "utf8");

    expect(llms).toContain("NoMoreIDE");
    expect(llms).toContain("https://www.nomoreide.com/llms-full.txt");
    expect(full).toContain("MCP Tool Reference");
    expect(full).toContain("Safety Model");
    expect(aiGuide).toContain("# NoMoreIDE AI Agent Guide");
    expect(aiGuide).toContain("nomoreide_list_services");
  });
});
