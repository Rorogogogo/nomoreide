import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const appSource = readFileSync(resolve(__dirname, "../website/src/App.tsx"), "utf8");
const heroSource = readFileSync(resolve(__dirname, "../website/src/components/hero.tsx"), "utf8");

describe("website hero", () => {
  test("leads with the product-first NoMoreIDE message and mock", () => {
    expect(heroSource).toContain('<span className="block">Use NoMoreIDE.</span>');
    expect(heroSource).toContain('<span className="block">You need no more IDE.</span>');
    expect(heroSource).toContain("Built for");
    expect(heroSource).toContain("vibe coders");
    expect(heroSource).toContain("your AI agent can run services, read");
    expect(heroSource).toContain("logs, review diffs, inspect data");
    expect(heroSource).toContain("Try the live mock");
    expect(heroSource).toContain("<WorkbenchApp syncLocation={false} />");
  });

  test("loads and displays the current GitHub star count", () => {
    expect(heroSource).toContain("https://api.github.com/repos/Rorogogogo/nomoreide");
    expect(heroSource).toContain("stargazers_count");
    expect(heroSource).toContain("GitHub stars");
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
