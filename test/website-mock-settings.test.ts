import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

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
});
