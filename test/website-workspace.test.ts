import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const root = resolve(__dirname, "..");
const rootPackage = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  workspaces?: string[];
};
const websitePackage = JSON.parse(
  readFileSync(resolve(root, "apps/website/package.json"), "utf8"),
) as {
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};
const dashboardPackage = JSON.parse(
  readFileSync(resolve(root, "apps/dashboard/package.json"), "utf8"),
) as { exports?: Record<string, string> };
const heroSource = readFileSync(
  resolve(root, "apps/website/src/components/hero.tsx"),
  "utf8",
);
const viteConfig = readFileSync(resolve(root, "apps/website/vite.config.ts"), "utf8");

describe("website workspace", () => {
  test("declares the website and dashboard as sibling workspaces", () => {
    expect(rootPackage.workspaces).toEqual(
      expect.arrayContaining(["apps/dashboard", "apps/website"]),
    );
    expect(websitePackage.dependencies?.["@nomoreide/dashboard"]).toBe("*");
    expect(dashboardPackage.exports?.["./app"]).toBe("./src/app.tsx");
    expect(heroSource).toContain('from "@nomoreide/dashboard/app"');
  });

  test("builds through the shared workspace dependency without a package alias bridge", () => {
    expect(websitePackage.scripts?.build).toBe("vite build");
    expect(viteConfig).not.toContain("browserPackageAliases");
    expect(viteConfig).not.toContain("websiteNodeModules");
    expect(viteConfig).not.toContain("dedupe:");
  });
});
