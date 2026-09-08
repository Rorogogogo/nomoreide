import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { PAGE_PATHS } from "../apps/dashboard/src/app-routing";

/**
 * The client's route table and the daemon's shell allowlist must agree.
 *
 * **This test used to exist and was lost.** It was written against the
 * TypeScript server and deleted with it, leaving `app-routing.ts` promising a
 * guard that no longer ran — and the two drifted immediately: `/linear` was
 * added to the client and not to the server, so the Linear page worked when
 * navigated to and 404'd on refresh or on a pasted link. That is a bad failure
 * to have, because the broken case is the one you hit when you send somebody a
 * URL.
 *
 * It reads the Rust source as text rather than shelling out to a binary. That
 * is crude, and it is the cheapest thing that runs in the Node test job — the
 * alternative is a cross-language fixture that has to be regenerated, which is
 * one more thing to forget.
 */
const RUST = "crates/nomoreide-daemon/src/server/static_assets.rs";

function serverShellPaths(): string[] {
  const source = readFileSync(RUST, "utf8");
  const block = /const SHELL_PATHS: &\[&str\] = &\[(.*?)\];/s.exec(source);
  if (!block) throw new Error(`SHELL_PATHS not found in ${RUST}`);
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

describe("shell paths", () => {
  test("every client page is a path the daemon serves the shell for", () => {
    const server = new Set(serverShellPaths());
    const missing = Object.entries(PAGE_PATHS)
      .filter(([, path]) => !server.has(path))
      .map(([page, path]) => `${page} -> ${path}`);
    expect(missing).toEqual([]);
  });

  test("the daemon serves no shell path the client cannot render", () => {
    const client = new Set(Object.values(PAGE_PATHS));
    // A path here that no page claims is a URL that renders the app and then
    // lands on Home — a dead entry that reads as a working link.
    expect(serverShellPaths().filter((path) => !client.has(path))).toEqual([]);
  });
});
