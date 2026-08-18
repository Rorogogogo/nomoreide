import { describe, expect, test } from "vitest";
import { extensionPath, PAGE_PATHS } from "../src/web/client/src/app";
import { servesShell, shellPathPrefixes, shellPaths } from "../src/web/routes/shell-routes";

describe("SPA shell paths", () => {
  test("serves every client route on direct load", () => {
    const missing = Object.entries(PAGE_PATHS)
      .filter(([, path]) => !shellPaths.has(path))
      .map(([page, path]) => `${page} (${path})`);

    expect(
      missing,
      `Add these to shellPaths in src/web/routes/shell-routes.ts, or loading them directly 404s: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  test("has no shell path the client cannot route", () => {
    const clientPaths = new Set(Object.values(PAGE_PATHS));
    const orphaned = [...shellPaths].filter((path) => !clientPaths.has(path));

    expect(orphaned).toEqual([]);
  });

  /**
   * The second-layer nav's paths carry a plugin id, so they cannot be listed:
   * which plugins exist is data. The prefix is the parity mechanism instead,
   * and it is worth its own test because the failure is invisible in-app —
   * navigation works, and only a refresh or a shared link 404s.
   */
  test("serves a plugin's page on direct load, whatever it is called", () => {
    for (const id of ["vercel", "cloudflare", "vultr", "some-future-plugin"]) {
      expect(servesShell(extensionPath(id)), `${id} 404s on refresh`).toBe(true);
    }
  });

  test("the client builds paths the prefix actually matches", () => {
    for (const prefix of shellPathPrefixes) {
      expect(shellPaths.has(prefix.replace(/\/$/, ""))).toBe(true);
    }
    expect(extensionPath("vercel").startsWith(shellPathPrefixes[0])).toBe(true);
  });

  test("a bare prefix is not a page", () => {
    // `/extensions` is one (exact match); `/extensions/` names no plugin.
    expect(servesShell("/extensions/")).toBe(false);
    expect(servesShell("/extensions")).toBe(true);
  });

  test("does not serve the shell for paths that route nowhere", () => {
    expect(servesShell("/nope")).toBe(false);
    expect(servesShell("/terminal")).toBe(false);
    expect(servesShell("/api/health")).toBe(false);
  });
});
