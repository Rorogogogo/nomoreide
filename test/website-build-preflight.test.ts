import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

const root = resolve(__dirname, "..");
const packageJson = JSON.parse(
  readFileSync(resolve(root, "website/package.json"), "utf8"),
) as { scripts?: Record<string, string> };

describe("website build preflight", () => {
  test("runs before the Vercel website build", () => {
    expect(packageJson.scripts?.build).toBe(
      "node scripts/verify-shared-deps.mjs && vite build",
    );
  });

  test("catches shared product imports that Vercel must resolve from website dependencies", () => {
    const result = spawnSync("node", ["scripts/verify-shared-deps.mjs"], {
      cwd: resolve(root, "website"),
      encoding: "utf8",
    });

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Website shared dependency preflight passed");
    expect(result.status).toBe(0);
  });
});
