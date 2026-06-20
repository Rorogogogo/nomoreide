import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// The connection-status type lives in the seam's API contract module after the
// transport-seam refactor (the `github.ts` barrel only re-exports it).
const apiSource = readFileSync("src/web/client/src/lib/api/github-api.ts", "utf8");
const hookSource = readFileSync(
  "src/web/client/src/features/github/hooks/use-github-token.ts",
  "utf8",
);

describe("GitHub token client status", () => {
  test("types expose explicit connection states", () => {
    expect(apiSource).toContain("export type GitHubConnectionStatus");
    expect(apiSource).toContain('"not_configured"');
    expect(apiSource).toContain('"connected"');
    expect(apiSource).toContain('"auth_error"');
    expect(apiSource).toContain('"connection_error"');
  });

  test("hook exposes status, error, and refresh", () => {
    expect(hookSource).toContain("status");
    expect(hookSource).toContain("error");
    expect(hookSource).toContain("refresh");
    expect(hookSource).toContain("isConnected");
  });
});
