import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const gitApiSource = readFileSync(
  resolve(__dirname, "../src/web/client/src/lib/api/git.ts"),
  "utf8",
);

describe("git web API helpers", () => {
  test("exposes branch creation helper for create-and-checkout flows", () => {
    expect(gitApiSource).toContain("export async function gitCreateBranch");
    expect(gitApiSource).toContain('"/api/git/branches"');
    expect(gitApiSource).toContain("name");
  });
});
