import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  publicVercelConnection,
  readVercelCliSession,
  resolveVercelCredential,
} from "../src/core/vercel-auth.js";
import { resetVercelOAuthDiscoveryCache } from "../src/core/vercel-oauth.js";
import type { NoMoreIdeConfig } from "../src/core/types.js";

let tempDir: string;
/** Points the CLI-auth lookup at a fixture instead of the real machine. */
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-vercel-"));
  // HOME as well as XDG_DATA_HOME: the lookup also probes `~/.vercel` and
  // `~/.now`, and without redirecting HOME these tests would read (and pass or
  // fail on) the real machine's Vercel login.
  env = { HOME: tempDir, XDG_DATA_HOME: tempDir };
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function writeCliSession(token: string, currentTeam?: string): Promise<void> {
  const dir = join(tempDir, "com.vercel.cli");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "auth.json"), JSON.stringify({ token }));
  if (currentTeam) {
    await writeFile(join(dir, "config.json"), JSON.stringify({ currentTeam }));
  }
}

describe("Vercel CLI session discovery", () => {
  test("reads the token and current scope from the CLI's auth files", async () => {
    await writeCliSession("cli-token", "team_acme");

    await expect(readVercelCliSession(env)).resolves.toEqual({
      token: "cli-token",
      currentTeam: "team_acme",
    });
  });

  test("treats a missing or malformed auth file as not logged in", async () => {
    await expect(readVercelCliSession(env)).resolves.toBeNull();

    const dir = join(tempDir, "com.vercel.cli");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "auth.json"), "{ not json");
    await expect(readVercelCliSession(env)).resolves.toBeNull();
  });
});

describe("Vercel credential resolution", () => {
  test("a stored connection uses its own token", async () => {
    const config = makeConfig({ source: "stored", token: "pat-token", teamId: "team_x" });

    await expect(resolveVercelCredential(config, env)).resolves.toEqual({
      source: "stored",
      token: "pat-token",
      teamId: "team_x",
      teamSlug: undefined,
    });
  });

  test("a CLI connection re-reads the token rather than storing a copy", async () => {
    await writeCliSession("fresh-cli-token", "team_acme");
    const config = makeConfig({ source: "cli" });

    const credential = await resolveVercelCredential(config, env);
    expect(credential).toEqual({
      source: "cli",
      token: "fresh-cli-token",
      // Inherited from the CLI's own scope, so the dashboard opens on the same
      // team `vercel` is pointed at.
      teamId: "team_acme",
      teamSlug: undefined,
    });
  });

  test("an explicitly chosen team wins over the CLI's current scope", async () => {
    await writeCliSession("cli-token", "team_cli");
    const config = makeConfig({ source: "cli", teamId: "team_chosen" });

    await expect(resolveVercelCredential(config, env)).resolves.toMatchObject({
      teamId: "team_chosen",
    });
  });

  test("a logged-out CLI reports how to recover instead of silently failing", async () => {
    const config = makeConfig({ source: "cli" });

    await expect(resolveVercelCredential(config, env)).rejects.toThrow("vercel login");
  });

  test("no connection falls back to the CLI when one is logged in", async () => {
    await writeCliSession("cli-token");

    await expect(resolveVercelCredential(makeConfig(), env)).resolves.toMatchObject({
      source: "cli",
      token: "cli-token",
    });
  });

  test("no connection and no CLI login is an actionable error", async () => {
    await expect(resolveVercelCredential(makeConfig(), env)).rejects.toThrow(
      "Vercel is not connected",
    );
  });
});

describe("OAuth credential resolution", () => {
  const oauthConfig = (overrides: Partial<NonNullable<NoMoreIdeConfig["vercel"]>> = {}) =>
    makeConfig({
      source: "oauth",
      token: "at_current",
      refreshToken: "rt_current",
      clientId: "cl_test",
      expiresAt: Date.now() + 10 * 60 * 1000,
      ...overrides,
    });

  /** Stands in for the token endpoint; discovery is answered too. */
  const refreshStub = (payload: unknown) =>
    (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = url.includes("openid-configuration")
        ? {
            authorization_endpoint: "https://vercel.com/oauth/authorize",
            token_endpoint: "https://api.vercel.com/login/oauth/token",
          }
        : payload;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

  test("uses the stored access token while it is still valid", async () => {
    await expect(resolveVercelCredential(oauthConfig(), env)).resolves.toMatchObject({
      source: "oauth",
      token: "at_current",
    });
  });

  test("refreshes an expired token and hands the rotated pair to the caller", async () => {
    resetVercelOAuthDiscoveryCache();
    const saved: unknown[] = [];

    const credential = await resolveVercelCredential(
      oauthConfig({ expiresAt: Date.now() - 1000 }),
      env,
      {
        onTokensRefreshed: async (tokens) => {
          saved.push(tokens);
        },
        oauthDeps: {
          fetchImpl: refreshStub({
            access_token: "at_fresh",
            refresh_token: "rt_fresh",
            expires_in: 3600,
          }),
        },
      },
    );

    expect(credential.token).toBe("at_fresh");
    expect(saved).toMatchObject([{ accessToken: "at_fresh", refreshToken: "rt_fresh" }]);
  });

  test("asks the user to sign in again when there is nothing to refresh with", async () => {
    await expect(
      resolveVercelCredential(
        oauthConfig({ expiresAt: Date.now() - 1000, refreshToken: undefined }),
        env,
      ),
    ).rejects.toThrow("Sign in to Vercel again");
  });
});

describe("publicVercelConnection", () => {
  test("never returns the stored token", () => {
    expect(
      publicVercelConnection({ source: "stored", token: "secret", teamId: "team_x" }),
    ).toEqual({ source: "stored", teamId: "team_x" });
  });

  test("passes undefined through for a disconnected config", () => {
    expect(publicVercelConnection(undefined)).toBeUndefined();
  });
});

function makeConfig(vercel?: NoMoreIdeConfig["vercel"]): NoMoreIdeConfig {
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
    vercel,
  };
}
