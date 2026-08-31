import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const runnerSource = readFileSync(
  resolve(__dirname, "../apps/dashboard/src/features/workflows/use-workflow-runner.ts"),
  "utf8",
);

describe("workflow runner retained run state", () => {
  test("records run start and end timestamps for active and last-run UI", () => {
    expect(runnerSource).toContain("startedAt: number");
    expect(runnerSource).toContain("endedAt?: number");
    // A fresh start stamps now; a resumed run carries the original start forward.
    expect(runnerSource).toMatch(/startedAt:[^\n]*Date\.now\(\)/);
    expect(runnerSource).toMatch(/endedAt: Date\.now\(\)/);
  });

  test("treats the PR branch guard as an interactive block instead of a failure", () => {
    expect(runnerSource).toMatch(
      /catch \(caught\) \{[\s\S]*?step\.op === "assert-pr-branch"[\s\S]*?patch\(i, "blocked"[\s\S]*?halt\("blocked"\)/,
    );
  });
});
