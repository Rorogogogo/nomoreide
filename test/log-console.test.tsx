import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const source = readFileSync(
  resolve(__dirname, "../apps/dashboard/src/features/services/service-detail/log-console.tsx"),
  "utf8",
);

describe("LogConsole controls", () => {
  test("uses dark-aware active states for log filters", () => {
    expect(source).toContain("dark:border-amber-400/40");
    expect(source).toContain("dark:bg-amber-500/15");
    expect(source).toContain("dark:text-amber-300");
    expect(source).toContain("dark:border-emerald-400/40");
    expect(source).toContain("dark:bg-emerald-500/15");
    expect(source).toContain("dark:text-emerald-300");
  });
});
