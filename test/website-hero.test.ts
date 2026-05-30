import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const appSource = readFileSync(resolve(__dirname, "../website/src/App.tsx"), "utf8");
const heroSource = readFileSync(resolve(__dirname, "../website/src/components/hero.tsx"), "utf8");

describe("website hero", () => {
  test("leads with the product-first NoMoreIDE message and mock", () => {
    expect(heroSource).toContain("Use NoMoreIDE. You need no more IDE.");
    expect(heroSource).toContain("AI-native development kit for vibe coders");
    expect(heroSource).toContain("Try the live mock");
    expect(heroSource).toContain("<WorkbenchApp syncLocation={false} />");
  });

  test("keeps MCP setup commands on the page", () => {
    expect(heroSource).toContain('href="#mcp-setup"');
    expect(heroSource).toContain('id="mcp-setup"');
    expect(heroSource).toContain("claude mcp add --transport stdio nomoreide -- npx -y nomoreide");
    expect(heroSource).toContain("codex mcp add nomoreide -- npx -y nomoreide");
    expect(heroSource).toContain('"args": ["-y", "nomoreide"]');
  });

  test("does not render a duplicate real product demo below the hero", () => {
    expect(appSource).not.toContain("<RealProductDemo />");
  });
});
