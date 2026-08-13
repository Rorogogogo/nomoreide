import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import {
  beginVercelLogin,
  completeVercelLogin,
  discoverVercelOAuth,
  refreshVercelOAuthTokens,
  resetVercelOAuthDiscoveryCache,
  vercelCallbackUrl,
  VercelLoginSessions,
} from "../src/core/vercel-oauth.js";

const DISCOVERY = {
  issuer: "https://vercel.com",
  authorization_endpoint: "https://vercel.com/oauth/authorize",
  token_endpoint: "https://api.vercel.com/login/oauth/token",
  registration_endpoint: "https://api.vercel.com/login/oauth/register",
  userinfo_endpoint: "https://api.vercel.com/login/oauth/userinfo",
};

const REDIRECT = "http://127.0.0.1:4317/api/providers/vercel/oauth/callback";

interface Call {
  url: string;
  method: string;
  body: string | undefined;
}

/** A fetch double that answers discovery, registration and the token endpoint. */
function stubOAuth(
  overrides: { token?: unknown; tokenStatus?: number; register?: unknown } = {},
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : init?.body?.toString(),
    });

    const respond = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (url.includes("openid-configuration")) return respond(DISCOVERY);
    if (url === DISCOVERY.registration_endpoint) {
      return respond(overrides.register ?? { client_id: "cl_test" });
    }
    if (url === DISCOVERY.token_endpoint) {
      return respond(
        overrides.token ?? {
          access_token: "at_1",
          refresh_token: "rt_1",
          token_type: "Bearer",
          expires_in: 3600,
        },
        overrides.tokenStatus ?? 200,
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

const params = (body: string | undefined) => new URLSearchParams(body ?? "");

beforeEach(() => {
  resetVercelOAuthDiscoveryCache();
});

describe("Vercel OAuth discovery", () => {
  test("caches the metadata instead of re-fetching per call", async () => {
    const { fetchImpl, calls } = stubOAuth();
    const now = () => 1_000;

    await discoverVercelOAuth({ fetchImpl, now });
    await discoverVercelOAuth({ fetchImpl, now });

    expect(calls.filter((call) => call.url.includes("openid-configuration"))).toHaveLength(1);
  });

  test("fails loudly when the issuer omits an endpoint it needs", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ issuer: "https://vercel.com" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    await expect(discoverVercelOAuth({ fetchImpl })).rejects.toThrow(
      /authorization or token endpoint/,
    );
  });
});

describe("beginVercelLogin", () => {
  test("registers the exact redirect it is about to send the user to", async () => {
    const { fetchImpl, calls } = stubOAuth();

    await beginVercelLogin(REDIRECT, { fetchImpl });

    const registration = calls.find((call) => call.url === DISCOVERY.registration_endpoint);
    expect(registration?.method).toBe("POST");
    expect(JSON.parse(registration?.body ?? "{}").redirect_uris).toEqual([REDIRECT]);
  });

  test("derives the S256 challenge from the verifier it keeps", async () => {
    const { fetchImpl } = stubOAuth();

    const pending = await beginVercelLogin(REDIRECT, { fetchImpl });

    const expected = createHash("sha256").update(pending.verifier).digest().toString("base64url");
    expect(new URL(pending.authorizeUrl).searchParams.get("code_challenge")).toBe(expected);
    expect(new URL(pending.authorizeUrl).searchParams.get("code_challenge_method")).toBe("S256");
  });

  test("requests offline_access, without which no refresh token is issued", async () => {
    const { fetchImpl } = stubOAuth();

    const pending = await beginVercelLogin(REDIRECT, { fetchImpl });

    expect(new URL(pending.authorizeUrl).searchParams.get("scope")).toBe("offline_access");
  });
});

describe("token exchange", () => {
  test("sends the verifier so the authorization server can check the challenge", async () => {
    const { fetchImpl, calls } = stubOAuth();
    const pending = await beginVercelLogin(REDIRECT, { fetchImpl });

    const tokens = await completeVercelLogin(pending, "the-code", { fetchImpl, now: () => 10_000 });

    const exchange = params(calls.at(-1)?.body);
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("code")).toBe("the-code");
    expect(exchange.get("code_verifier")).toBe(pending.verifier);
    expect(exchange.get("redirect_uri")).toBe(REDIRECT);
    expect(tokens).toEqual({
      accessToken: "at_1",
      refreshToken: "rt_1",
      expiresAt: 10_000 + 3_600_000,
    });
  });

  test("surfaces the authorization server's own error text", async () => {
    const { fetchImpl } = stubOAuth({
      tokenStatus: 400,
      token: { error: "invalid_grant", error_description: "Code already redeemed" },
    });

    await expect(
      refreshVercelOAuthTokens("cl_test", "rt_stale", { fetchImpl }),
    ).rejects.toThrow("Code already redeemed (invalid_grant)");
  });

  test("returns the rotated refresh token so the spent one is replaced", async () => {
    const { fetchImpl, calls } = stubOAuth({
      token: { access_token: "at_2", refresh_token: "rt_2", expires_in: 3600 },
    });

    const tokens = await refreshVercelOAuthTokens("cl_test", "rt_1", { fetchImpl });

    expect(params(calls.at(-1)?.body).get("grant_type")).toBe("refresh_token");
    expect(params(calls.at(-1)?.body).get("refresh_token")).toBe("rt_1");
    expect(tokens.refreshToken).toBe("rt_2");
  });
});

describe("VercelLoginSessions", () => {
  const login = (state: string, createdAt: number) => ({
    state,
    verifier: "v",
    clientId: "cl_test",
    redirectUri: REDIRECT,
    authorizeUrl: "https://vercel.com/oauth/authorize",
    createdAt,
  });

  test("hands a pending login back exactly once", () => {
    const sessions = new VercelLoginSessions(() => 0);
    sessions.remember(login("s1", 0));

    expect(sessions.take("s1")?.state).toBe("s1");
    expect(sessions.take("s1")).toBeUndefined();
  });

  test("ignores a state it never issued", () => {
    const sessions = new VercelLoginSessions(() => 0);

    expect(sessions.take("forged")).toBeUndefined();
  });

  test("expires a login the user abandoned", () => {
    let now = 0;
    const sessions = new VercelLoginSessions(() => now);
    sessions.remember(login("s1", 0));

    now = 11 * 60 * 1000;

    expect(sessions.take("s1")).toBeUndefined();
  });
});

describe("vercelCallbackUrl", () => {
  test.each(["127.0.0.1:4317", "localhost:5173"])("accepts the loopback host %s", (host) => {
    expect(vercelCallbackUrl(host)).toBe(`http://${host}/api/providers/vercel/oauth/callback`);
  });

  test.each(["example.com", "192.168.1.10:4317", undefined])(
    "refuses to send the code to %s",
    (host) => {
      expect(() => vercelCallbackUrl(host)).toThrow(/loopback/);
    },
  );
});
