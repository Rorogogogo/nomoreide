import { createHash, randomBytes } from "node:crypto";

/**
 * Browser sign-in for Vercel: OAuth 2.0 authorization code + PKCE against a
 * loopback redirect (RFC 8252, "OAuth 2.0 for Native Apps").
 *
 * Why not the device flow we use for GitHub: Vercel restricts
 * `urn:ietf:params:oauth:grant-type:device_code` to its own first-party
 * clients. A client we register is refused with `unauthorized_client`, so the
 * loopback flow is the only browser sign-in available to us.
 *
 * Two behaviours of Vercel's authorization server this module is built around:
 *
 * 1. `offline_access` is **required**. Without it the grant comes back with no
 *    refresh token and dies after an hour, forcing the user to sign in again.
 * 2. Refresh **rotates**: every refresh returns a new refresh token and
 *    invalidates the previous one, so the caller must persist what comes back.
 */

const VERCEL_ISSUER = "https://vercel.com";
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000;
/** Refresh a little early so a call never starts with an about-to-expire token. */
export const VERCEL_TOKEN_REFRESH_SKEW_MS = 60 * 1000;
const VERCEL_OAUTH_SCOPE = "offline_access";

export interface VercelOAuthMetadata {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  userinfoEndpoint?: string;
}

export interface VercelOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms at which `accessToken` stops being accepted. */
  expiresAt: number;
}

export interface VercelPendingLogin {
  state: string;
  verifier: string;
  clientId: string;
  redirectUri: string;
  authorizeUrl: string;
  createdAt: number;
}

/** Injected in tests; defaults to the global `fetch`. */
export interface VercelOAuthDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const call = (deps: VercelOAuthDeps | undefined): typeof fetch => deps?.fetchImpl ?? fetch;
const clock = (deps: VercelOAuthDeps | undefined): number => (deps?.now ?? Date.now)();

let cachedMetadata: { value: VercelOAuthMetadata; fetchedAt: number } | undefined;

/** Exposed for tests, which must not inherit another case's cached discovery. */
export function resetVercelOAuthDiscoveryCache(): void {
  cachedMetadata = undefined;
}

/**
 * The issuer's advertised endpoints. Discovered rather than hard-coded so a
 * move of the token or registration endpoint doesn't silently break sign-in.
 */
export async function discoverVercelOAuth(
  deps?: VercelOAuthDeps,
): Promise<VercelOAuthMetadata> {
  const now = clock(deps);
  if (cachedMetadata && now - cachedMetadata.fetchedAt < DISCOVERY_TTL_MS) {
    return cachedMetadata.value;
  }

  const response = await call(deps)(`${VERCEL_ISSUER}/.well-known/openid-configuration`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Vercel OAuth discovery failed (HTTP ${response.status}).`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  const authorizationEndpoint = stringField(body, "authorization_endpoint");
  const tokenEndpoint = stringField(body, "token_endpoint");
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error("Vercel OAuth discovery is missing its authorization or token endpoint.");
  }

  const value: VercelOAuthMetadata = {
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint: stringField(body, "registration_endpoint"),
    userinfoEndpoint: stringField(body, "userinfo_endpoint"),
  };
  cachedMetadata = { value, fetchedAt: now };
  return value;
}

/**
 * Registers a client for `redirectUri` (RFC 7591).
 *
 * Called immediately before every sign-in rather than once at install time:
 * the endpoint hands back a shared client whose redirect list is replaced by
 * whatever was registered last, so re-registering is what guarantees our own
 * redirect is the one in force when we send the user to the consent screen.
 */
export async function registerVercelOAuthClient(
  metadata: VercelOAuthMetadata,
  redirectUri: string,
  deps?: VercelOAuthDeps,
): Promise<string> {
  if (!metadata.registrationEndpoint) {
    throw new Error("Vercel does not advertise a client registration endpoint.");
  }
  const response = await call(deps)(metadata.registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "NoMoreIDE",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
    }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(oauthErrorMessage(body) ?? `Client registration failed (HTTP ${response.status}).`);
  }
  const clientId = stringField(body, "client_id");
  if (!clientId) throw new Error("Vercel returned no client_id.");
  return clientId;
}

/** Registers a client and builds the URL the user's browser must open. */
export async function beginVercelLogin(
  redirectUri: string,
  deps?: VercelOAuthDeps,
): Promise<VercelPendingLogin> {
  const metadata = await discoverVercelOAuth(deps);
  const clientId = await registerVercelOAuthClient(metadata, redirectUri, deps);

  const verifier = base64Url(randomBytes(32));
  const state = base64Url(randomBytes(16));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());

  const authorizeUrl = new URL(metadata.authorizationEndpoint);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("scope", VERCEL_OAUTH_SCOPE);

  return {
    state,
    verifier,
    clientId,
    redirectUri,
    authorizeUrl: authorizeUrl.toString(),
    createdAt: clock(deps),
  };
}

/** Exchanges the authorization code the callback received for tokens. */
export async function completeVercelLogin(
  pending: VercelPendingLogin,
  code: string,
  deps?: VercelOAuthDeps,
): Promise<VercelOAuthTokens> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: pending.redirectUri,
      client_id: pending.clientId,
      code_verifier: pending.verifier,
    }),
    deps,
  );
}

/**
 * Trades a refresh token for a fresh access token. The returned
 * `refreshToken` replaces the one passed in — Vercel rotates on every use.
 */
export async function refreshVercelOAuthTokens(
  clientId: string,
  refreshToken: string,
  deps?: VercelOAuthDeps,
): Promise<VercelOAuthTokens> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }),
    deps,
  );
}

async function tokenRequest(
  body: URLSearchParams,
  deps?: VercelOAuthDeps,
): Promise<VercelOAuthTokens> {
  const metadata = await discoverVercelOAuth(deps);
  const response = await call(deps)(metadata.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(oauthErrorMessage(parsed) ?? `Vercel token request failed (HTTP ${response.status}).`);
  }

  const accessToken = stringField(parsed, "access_token");
  if (!accessToken) throw new Error("Vercel returned no access token.");
  const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : 3600;
  return {
    accessToken,
    refreshToken: stringField(parsed, "refresh_token"),
    expiresAt: clock(deps) + expiresIn * 1000,
  };
}

/**
 * The sign-ins awaiting their callback. Kept in memory, never on disk: the
 * PKCE verifier is only meaningful for the minutes between the redirect and
 * the callback, and a restart mid-login is better restarted than resumed.
 */
export class VercelLoginSessions {
  private readonly pending = new Map<string, VercelPendingLogin>();

  constructor(private readonly now: () => number = Date.now) {}

  remember(login: VercelPendingLogin): void {
    this.sweep();
    this.pending.set(login.state, login);
  }

  /** Returns and forgets the login for `state`; a code is only redeemable once. */
  take(state: string): VercelPendingLogin | undefined {
    this.sweep();
    const login = this.pending.get(state);
    if (login) this.pending.delete(state);
    return login;
  }

  private sweep(): void {
    const cutoff = this.now() - PENDING_LOGIN_TTL_MS;
    for (const [state, login] of this.pending) {
      if (login.createdAt < cutoff) this.pending.delete(state);
    }
  }
}

/**
 * The loopback callback URL for a request that arrived on `host`.
 *
 * Derived from the incoming Host header so the flow works on whatever port the
 * daemon (or the Vite dev proxy) is actually serving, and rejected unless it is
 * loopback — a redirect pointing anywhere else would hand the code to a host
 * that is not this machine.
 */
export function vercelCallbackUrl(host: string | undefined): string {
  const hostname = host?.trim().replace(/^\[|\]$/g, "").split(":")[0];
  if (!host || !hostname || !isLoopbackHost(hostname)) {
    throw new Error("Vercel sign-in requires a loopback address (localhost or 127.0.0.1).");
  }
  return `http://${host}/api/vercel/oauth/callback`;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function stringField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function oauthErrorMessage(body: Record<string, unknown>): string | undefined {
  const description = stringField(body, "error_description");
  const error = stringField(body, "error");
  if (description && error) return `${description} (${error})`;
  return description ?? error;
}
