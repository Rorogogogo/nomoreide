import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

// Post transport-seam refactor the helpers are re-exported from the `git.ts`
// barrel and implemented (with their endpoints) in the HTTP backend.
const apiDir = resolve(__dirname, "../src/web/client/src/lib/api");
const gitBarrel = readFileSync(resolve(apiDir, "git.ts"), "utf8");
const gitHttp = readFileSync(resolve(apiDir, "git-http.ts"), "utf8");

describe("git web API helpers", () => {
  test("exposes branch creation helper for create-and-checkout flows", () => {
    expect(gitBarrel).toContain("gitCreateBranch");
    expect(gitHttp).toContain("gitCreateBranch");
    expect(gitHttp).toContain('"/api/git/branches"');
  });

  test("exposes a helper for switching back to the default branch and pulling", () => {
    expect(gitBarrel).toContain("gitCheckoutDefaultAndPull");
    expect(gitHttp).toContain("gitCheckoutDefaultAndPull");
    expect(gitHttp).toContain('"/api/git/default-branch/pull"');
  });
});
