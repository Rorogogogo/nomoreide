import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  providerCliStatus,
  readJsonField,
  resolveProviderCredential,
  type ProviderAuthSpec,
} from "../src/core/providers/credentials.js";
import {
  discoverOAuth,
  loopbackCallbackUrl,
  resetOAuthDiscoveryCache,
  type ProviderOAuthSpec,
} from "../src/core/providers/oauth.js";
import type { NoMoreIdeConfig, ProviderConnection } from "../src/core/types.js";

/**
 * The shared layer exercised through a provider that is deliberately *not*
 * Vercel — if any of this still reads as Vercel-shaped, provider #2 pays for it.
 */

let tempDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-provider-"));
  env = { HOME: tempDir };
  resetOAuthDiscoveryCache();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const MESSAGES = {
  cliMissing: "No Acme CLI login found. Run `acme login`.",
  noStoredToken: "No Acme token stored.",
  cliLoggedOut: "The Acme CLI is no longer logged in.",
  notConnected: "Acme is not connected.",
  signInExpired: "Your Acme sign-in has expired.",
  refreshFailed: "Could not renew your Acme sign-in ({error}).",
};

const ACME_OAUTH: ProviderOAuthSpec = {
  name: "Acme",
  issuer: "https://acme.test",
  scope: "offline_access",
  callbackPath: "/api/providers/acme/oauth/callback",
};

/** A provider with a CLI, mirroring Vercel's three-source shape. */
function acmeSpec(): ProviderAuthSpec {
  return {
    id: "acme",
    name: "Acme",
    cliSession: async (candidateEnv) => {
      const token = await readJsonField(
        join(candidateEnv.HOME ?? "", ".acme", "auth.json"),
        "token",
      );
      if (!token) return null;
      const currentScope = await readJsonField(
        join(candidateEnv.HOME ?? "", ".acme", "config.json"),
        "account",
      );
      return { token, currentScope: currentScope || undefined };
    },
    oauth: ACME_OAUTH,
    messages: MESSAGES,
  };
}

/** A key-only provider — no CLI, no browser sign-in. This is Vultr's shape. */
const keyOnlySpec: ProviderAuthSpec = {
  id: "keyonly",
  name: "KeyOnly",
  messages: MESSAGES,
};

async function writeAcmeCliSession(token: string, account?: string): Promise<void> {
  const dir = join(tempDir, ".acme");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "auth.json"), JSON.stringify({ token }));
  if (account) await writeFile(join(dir, "config.json"), JSON.stringify({ account }));
}

function makeConfig(connections: Record<string, ProviderConnection> = {}): NoMoreIdeConfig {
  return {
    version: 1,
    services: [],
    bundles: [],
    gitRepositories: [],
    databases: [],
    logSources: [],
    githubTokens: [],
    githubIdentities: [],
    workflows: [],
    workflowTriggers: [],
    connections,
  };
}

describe("credential resolution is provider-shaped, not Vercel-shaped", () => {
  test("a provider with no CLI hook never resolves a cli source", async () => {
    // Even with an Acme CLI login sitting on disk, a spec that declares no
    // `cliSession` must not reach for one — that is how a key-only provider
    // (Vultr) stays key-only.
    await writeAcmeCliSession("cli-token");

    await expect(resolveProviderCredential(keyOnlySpec, makeConfig(), env)).rejects.toThrow(
      MESSAGES.notConnected,
    );
    await expect(providerCliStatus(keyOnlySpec, env)).resolves.toEqual({
      available: false,
      error: MESSAGES.cliMissing,
    });
  });

  test("the CLI's own scope is inherited, and an explicit one still wins", async () => {
    await writeAcmeCliSession("cli-token", "acct_from_cli");

    await expect(resolveProviderCredential(acmeSpec(), makeConfig(), env)).resolves.toEqual({
      source: "cli",
      token: "cli-token",
      scopeId: "acct_from_cli",
      scopeSlug: undefined,
    });

    const pinned = makeConfig({ acme: { source: "cli", scopeId: "acct_chosen" } });
    await expect(resolveProviderCredential(acmeSpec(), pinned, env)).resolves.toMatchObject({
      scopeId: "acct_chosen",
    });
  });

  test("a cli connection reads the live token rather than any copy in config", async () => {
    await writeAcmeCliSession("rotated-by-the-cli");
    // A stale token left in the record must be ignored: the whole point of the
    // `cli` source is that `acme logout` revokes us too.
    const config = makeConfig({ acme: { source: "cli", token: "stale-copy" } });

    await expect(resolveProviderCredential(acmeSpec(), config, env)).resolves.toMatchObject({
      token: "rotated-by-the-cli",
    });
  });

  test("every failure message comes from the spec", async () => {
    const spec = acmeSpec();

    await expect(resolveProviderCredential(spec, makeConfig(), env)).rejects.toThrow(
      MESSAGES.notConnected,
    );
    await expect(
      resolveProviderCredential(spec, makeConfig({ acme: { source: "cli" } }), env),
    ).rejects.toThrow(MESSAGES.cliLoggedOut);
    await expect(
      resolveProviderCredential(spec, makeConfig({ acme: { source: "stored" } }), env),
    ).rejects.toThrow(MESSAGES.noStoredToken);
    await expect(
      resolveProviderCredential(
        spec,
        makeConfig({ acme: { source: "oauth", token: "at", expiresAt: 0 } }),
        env,
      ),
    ).rejects.toThrow(MESSAGES.signInExpired);
  });

  test("a refresh failure interpolates the underlying error into the spec's message", async () => {
    const config = makeConfig({
      acme: {
        source: "oauth",
        token: "at_stale",
        refreshToken: "rt_stale",
        clientId: "cl_1",
        expiresAt: 0,
      },
    });

    await expect(
      resolveProviderCredential(acmeSpec(), config, env, {
        oauthDeps: {
          fetchImpl: (async (input: string | URL | Request) => {
            const url = input instanceof Request ? input.url : String(input);
            const body = url.includes("openid-configuration")
              ? {
                  authorization_endpoint: "https://acme.test/oauth/authorize",
                  token_endpoint: "https://acme.test/oauth/token",
                }
              : { error: "invalid_grant", error_description: "Refresh token revoked" };
            return new Response(JSON.stringify(body), {
              status: url.includes("openid-configuration") ? 200 : 400,
              headers: { "content-type": "application/json" },
            });
          }) as unknown as typeof fetch,
        },
      }),
    ).rejects.toThrow("Could not renew your Acme sign-in (Refresh token revoked (invalid_grant)).");
  });

  test("an oauth connection with no oauth spec cannot silently refresh", async () => {
    // A `stored`-only provider holding an expired oauth record has no endpoint
    // to renew against; it must say so rather than throw something opaque.
    const config = makeConfig({
      keyonly: {
        source: "oauth",
        token: "at",
        refreshToken: "rt",
        clientId: "cl",
        expiresAt: 0,
      },
    });

    await expect(resolveProviderCredential(keyOnlySpec, config, env)).rejects.toThrow(
      MESSAGES.signInExpired,
    );
  });
});

describe("OAuth discovery is keyed per issuer", () => {
  /** Answers discovery with endpoints derived from whichever issuer was asked. */
  const discoveryStub = () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      seen.push(url);
      const issuer = new URL(url).origin;
      return new Response(
        JSON.stringify({
          authorization_endpoint: `${issuer}/oauth/authorize`,
          token_endpoint: `${issuer}/oauth/token`,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    return { fetchImpl, seen };
  };

  test("two providers never serve each other's endpoints", async () => {
    const { fetchImpl } = discoveryStub();
    const other: ProviderOAuthSpec = { ...ACME_OAUTH, name: "Other", issuer: "https://other.test" };

    const acme = await discoverOAuth(ACME_OAUTH, { fetchImpl });
    const others = await discoverOAuth(other, { fetchImpl });

    expect(acme.tokenEndpoint).toBe("https://acme.test/oauth/token");
    expect(others.tokenEndpoint).toBe("https://other.test/oauth/token");
  });

  test("clearing one issuer leaves the other's cache intact", async () => {
    const { fetchImpl, seen } = discoveryStub();
    const other: ProviderOAuthSpec = { ...ACME_OAUTH, name: "Other", issuer: "https://other.test" };
    const now = () => 1_000;

    await discoverOAuth(ACME_OAUTH, { fetchImpl, now });
    await discoverOAuth(other, { fetchImpl, now });
    resetOAuthDiscoveryCache(ACME_OAUTH.issuer);
    await discoverOAuth(ACME_OAUTH, { fetchImpl, now });
    await discoverOAuth(other, { fetchImpl, now });

    expect(seen.filter((url) => url.startsWith("https://acme.test"))).toHaveLength(2);
    expect(seen.filter((url) => url.startsWith("https://other.test"))).toHaveLength(1);
  });
});

describe("loopbackCallbackUrl", () => {
  test("builds the provider's own callback path", () => {
    expect(loopbackCallbackUrl(ACME_OAUTH, "127.0.0.1:4317")).toBe(
      "http://127.0.0.1:4317/api/providers/acme/oauth/callback",
    );
  });

  test("names the provider when refusing a non-loopback host", () => {
    expect(() => loopbackCallbackUrl(ACME_OAUTH, "example.com")).toThrow(
      "Acme sign-in requires a loopback address",
    );
  });
});
