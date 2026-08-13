import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  CLOUDFLARE_AUTH,
  cloudflareCliStatus,
  readWranglerSession,
} from "../src/core/cloudflare-auth.js";
import { resolveProviderCredential } from "../src/core/providers/credentials.js";
import type { NoMoreIdeConfig } from "../src/core/types.js";

/**
 * Cloudflare's half of the shared credential layer — the second provider to go
 * through it, and the one that shows which parts were Vercel-shaped.
 *
 * Two differences are asserted rather than assumed: the vendor CLI stores its
 * login as TOML rather than JSON, and there is no browser sign-in at all.
 */

let tempDir: string;
/** Points the CLI-auth lookup at a fixture instead of the real machine. */
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-cloudflare-"));
  // HOME as well as XDG_CONFIG_HOME: the lookup also probes `~/.wrangler` and
  // the platform's own directory, and without redirecting HOME these tests
  // would read (and pass or fail on) the real machine's Wrangler login.
  env = { HOME: tempDir, XDG_CONFIG_HOME: tempDir };
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function writeWranglerConfig(body: string): Promise<void> {
  const dir = join(tempDir, ".wrangler", "config");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "default.toml"), body);
}

const config = (overrides: Partial<NoMoreIdeConfig> = {}): NoMoreIdeConfig =>
  ({ connections: {}, gitRepositories: [], ...overrides }) as NoMoreIdeConfig;

describe("Wrangler session discovery", () => {
  test("reads the OAuth token Wrangler wrote, which is TOML rather than JSON", async () => {
    await writeWranglerConfig(
      [
        'oauth_token = "wrangler-token"',
        'refresh_token = "refresh"',
        `expiration_time = "${new Date(Date.now() + 3_600_000).toISOString()}"`,
      ].join("\n"),
    );

    expect(await readWranglerSession(env)).toEqual({ token: "wrangler-token", currentScope: undefined });
  });

  test("an expired token reads as logged out, not as a token to try", async () => {
    // Wrangler refreshes roughly hourly and rotates its refresh token when it
    // does, so renewing it here would invalidate Wrangler's own copy. Reporting
    // "not logged in" sends the user to `wrangler login`, which is the fix.
    await writeWranglerConfig(
      ['oauth_token = "stale"', 'expiration_time = "2020-01-01T00:00:00.000Z"'].join("\n"),
    );

    expect(await readWranglerSession(env)).toBeNull();
  });

  test("the environment's API token wins, and carries the account with it", async () => {
    await writeWranglerConfig('oauth_token = "wrangler-token"');

    expect(
      await readWranglerSession({
        ...env,
        CLOUDFLARE_API_TOKEN: "env-token",
        CLOUDFLARE_ACCOUNT_ID: "acct_1",
      }),
    ).toEqual({ token: "env-token", currentScope: "acct_1" });
  });

  test("the older CF_-prefixed variables are honoured too", async () => {
    expect(await readWranglerSession({ ...env, CF_API_TOKEN: "cf", CF_ACCOUNT_ID: "acct_2" })).toEqual(
      { token: "cf", currentScope: "acct_2" },
    );
  });

  test("a missing or malformed config is 'not logged in', never an error", async () => {
    expect(await readWranglerSession(env)).toBeNull();

    await writeWranglerConfig("not = toml = at [all");
    expect(await readWranglerSession(env)).toBeNull();
  });

  test("keys under a table header are not mistaken for the top-level ones", async () => {
    await writeWranglerConfig(['[some_table]', 'oauth_token = "not-the-login"'].join("\n"));

    expect(await readWranglerSession(env)).toBeNull();
  });

  test("no login produces the message that names the command to run", async () => {
    const status = await cloudflareCliStatus(env);

    expect(status.available).toBe(false);
    expect(status.error).toMatch(/wrangler login/);
  });
});

describe("Cloudflare through the shared credential resolver", () => {
  test("declares no browser sign-in, which the shared layer already allows for", () => {
    // `providers/oauth.ts` needs an issuer serving OIDC discovery *and* dynamic
    // client registration; Cloudflare's authorization server offers neither, so
    // the `oauth` source is simply never available. The three-source model
    // survives provider #2 — only this provider's subset of it is smaller.
    expect(CLOUDFLARE_AUTH.oauth).toBeUndefined();
    expect(CLOUDFLARE_AUTH.cliSession).toBeDefined();
  });

  test("a stored API token is used as-is", async () => {
    const connection = { source: "stored" as const, token: "api-token", scopeId: "acct_1" };

    await expect(
      resolveProviderCredential(CLOUDFLARE_AUTH, config({ connections: { cloudflare: connection } }), env),
    ).resolves.toEqual({ source: "stored", token: "api-token", scopeId: "acct_1", scopeSlug: undefined });
  });

  test("a Wrangler login is re-read at use time rather than copied into config", async () => {
    await writeWranglerConfig('oauth_token = "wrangler-token"');

    const credential = await resolveProviderCredential(CLOUDFLARE_AUTH, config(), env);

    expect(credential).toMatchObject({ source: "cli", token: "wrangler-token" });
  });

  test("no connection and no login is an actionable message, not a null", async () => {
    await expect(resolveProviderCredential(CLOUDFLARE_AUTH, config(), env)).rejects.toThrow(
      /Cloudflare is not connected/,
    );
  });
});
