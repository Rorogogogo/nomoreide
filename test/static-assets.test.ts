import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `sendStaticAsset` resolves a request path under a fixed set of roots. The
 * interesting cases are the ones that try to leave.
 */
describe("sendStaticAsset", () => {
  let root: string;
  let clientRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "nmi-static-assets-"));
    // Mirrors the real layout: the served root, and a sibling whose name
    // starts with it.
    clientRoot = join(root, "web", "client");
    await mkdir(join(clientRoot, "assets"), { recursive: true });
    await mkdir(join(root, "web", "client-evil"), { recursive: true });
    await writeFile(join(clientRoot, "assets", "app.js"), "export const app = 1;\n");
    await writeFile(join(root, "web", "client-evil", "secret.js"), "stolen\n");
  });

  afterEach(async () => {
    vi.resetModules();
    await rm(root, { recursive: true, force: true });
  });

  /** Serve from `clientRoot` alone, so the assertions are about path handling
   * rather than about which candidate root won. */
  async function send(requestPath: string) {
    vi.resetModules();
    const module = await import("../src/web/static-assets.js");
    // The module's roots are derived from its own location; the resolution
    // under test is the one inside the loop, so a single root is planted by
    // pointing the check at a response recorder and the known root.
    const chunks: Buffer[] = [];
    let status = 0;
    let headers: Record<string, string> = {};
    const response = {
      writeHead(code: number, value: Record<string, string>) {
        status = code;
        headers = value;
      },
      end(chunk?: Buffer) {
        if (chunk) chunks.push(chunk);
      },
    };
    const served = await module.sendStaticAssetFrom(
      response as never,
      requestPath,
      [clientRoot],
    );
    return { served, status, headers, body: Buffer.concat(chunks).toString("utf8") };
  }

  it("serves a file inside the root", async () => {
    const result = await send("/assets/app.js");
    expect(result.served).toBe(true);
    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(result.body).toContain("export const app");
  });

  it("allows dot segments that stay inside the root", async () => {
    const result = await send("/assets/../assets/app.js");
    expect(result.served).toBe(true);
    expect(result.body).toContain("export const app");
  });

  it("refuses a path that climbs out of the root", async () => {
    const result = await send("/assets/../../../etc/hosts");
    expect(result.served).toBe(false);
  });

  /**
   * The escape a bare `startsWith` let through: the resolved path is not
   * inside the root, but its string does begin with the root's.
   */
  it("refuses a sibling directory whose name extends the root's", async () => {
    const result = await send("/assets/../../client-evil/secret.js");
    expect(result.served).toBe(false);
    expect(result.body).not.toContain("stolen");
  });
});
