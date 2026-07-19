// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { installWebsiteMockApi } from "../website/src/mock-api";

const source = readFileSync(resolve(__dirname, "../website/src/mock-api.ts"), "utf8");

describe("website settings mock", () => {
  test("returns complete global and project settings instead of the bare fallback", () => {
    expect(source).toContain('path === "/api/settings"');
    expect(source).toContain('path === "/api/settings/global"');
    expect(source).toContain('path === "/api/settings/project"');
    expect(source).toContain('path === "/api/settings/global/reset"');
    expect(source).toContain('path === "/api/settings/project/reset"');
    expect(source).toContain("fontSize: 13");
    expect(source).toContain("confirmTerminate: true");
    expect(source).toContain("showTimestamps: true");
    expect(source).toContain("resultLimit: 100");
  });

  test("keeps project settings independent by projectPath", async () => {
    window.fetch = vi.fn(async () => new Response(null, { status: 404 }));
    installWebsiteMockApi();

    await window.fetch("/api/settings/project?projectPath=%2Fwork%2Fa", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ database: { resultLimit: 321 } }),
    });
    const response = await window.fetch("/api/settings?projectPath=%2Fwork%2Fb");
    const body = await response.json();

    expect(body.project.database.resultLimit).toBe(100);
  });
});
