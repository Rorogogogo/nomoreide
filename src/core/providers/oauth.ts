import { createHash, randomBytes } from "node:crypto";

/**
 * Browser sign-in for a deploy/host provider: OAuth 2.0 authorization code +
 * PKCE against a loopback redirect (RFC 8252, "OAuth 2.0 for Native Apps").
 *
 * Every provider that offers a browser sign-in needs the same seven things —
 * discovery, dynamic client registration, a PKCE challenge, the authorize URL,
 * the code exchange, a rotating refresh, and somewhere to park the verifier
 * between the redirect and the callback. None of that is vendor-specific. What
 * *is* vendor-specific is four constants, which arrive as a
 * {@link ProviderOAuthSpec}.
 *
 * Two behaviours this module is built around, both first met in Vercel's
 * authorization server and both common enough to be the default:
 *
 * 1. `offline_access` (or the provider's equivalent) is **required**. Without
 *    it the grant comes back with no refresh token and dies after an hour,
 *    forcing the user to sign in again. Hence `scope` is not optional.
 * 2. Refresh may **rotate**: a refresh can return a new refresh token and
 *    invalidate the previous one, so the caller must persist what comes back.
 *    Callers must treat the returned `refreshToken` as replacing the one they
 *    passed in, whether or not their provider rotates.
 */

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000;
/** Refresh a little early so a call never starts with an about-to-expire token. */
export const TOKEN_REFRESH_SKEW_MS = 60 * 1000;
const DEFAULT_CLIENT_NAME = "NoMoreIDE";

/**
 * The vendor-specific half of a browser sign-in.
 *
 * Deliberately four plain values and no behaviour: this is the shape that has
 * to survive being read out of a provider manifest rather than compiled in.
 */
export interface ProviderOAuthSpec {
  /** Display name, used verbatim in every message the user may see. */
  name: string;
  /** Issuer whose `/.well-known/openid-configuration` is read. */
  issuer: string;
  /** Scopes requested at authorize time, space-separated. */
  scope: string;
  /** Path the loopback redirect points at, e.g. `/api/providers/vercel/oauth/callback`. */
  callbackPath: string;
  /** Name registered with the authorization server. */
  clientName?: string;
}

export interface OAuthMetadata {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  userinfoEndpoint?: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms at which `accessToken` stops being accepted. */
  expiresAt: number;
}

export interface PendingLogin {
  state: string;
  verifier: string;
  clientId: string;
  redirectUri: string;
  authorizeUrl: string;
  createdAt: number;
}

/** Injected in tests; defaults to the global `fetch`. */
export interface OAuthDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const call = (deps: OAuthDeps | undefined): typeof fetch => deps?.fetchImpl ?? fetch;
export const clock = (deps: OAuthDeps | undefined): number => (deps?.now ?? Date.now)();

/**
 * Discovered metadata per issuer. Keyed rather than a single slot because two
 * providers signed in at once would otherwise serve each other's endpoints.
 */
const cachedMetadata = new Map<string, { value: OAuthMetadata; fetchedAt: number }>();

/**
 * Exposed for tests, which must not inherit another case's cached discovery.
 * With no argument every issuer is cleared.
 */
export function resetOAuthDiscoveryCache(issuer?: string): void {
  if (issuer) cachedMetadata.delete(issuer);
  else cachedMetadata.clear();
}

/**
 * The issuer's advertised endpoints. Discovered rather than hard-coded so a
 * move of the token or registration endpoint doesn't silently break sign-in.
 */
export async function discoverOAuth(
  spec: ProviderOAuthSpec,
  deps?: OAuthDeps,
): Promise<OAuthMetadata> {
  const now = clock(deps);
  const cached = cachedMetadata.get(spec.issuer);
  if (cached && now - cached.fetchedAt < DISCOVERY_TTL_MS) return cached.value;

  const response = await call(deps)(`${spec.issuer}/.well-known/openid-configuration`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`${spec.name} OAuth discovery failed (HTTP ${response.status}).`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  const authorizationEndpoint = stringField(body, "authorization_endpoint");
  const tokenEndpoint = stringField(body, "token_endpoint");
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error(
      `${spec.name} OAuth discovery is missing its authorization or token endpoint.`,
    );
  }

  const value: OAuthMetadata = {
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint: stringField(body, "registration_endpoint"),
    userinfoEndpoint: stringField(body, "userinfo_endpoint"),
  };
  cachedMetadata.set(spec.issuer, { value, fetchedAt: now });
  return value;
}

/**
 * Registers a client for `redirectUri` (RFC 7591).
 *
 * Called immediately before every sign-in rather than once at install time:
 * the endpoint may hand back a shared client whose redirect list is replaced by
 * whatever was registered last, so re-registering is what guarantees our own
 * redirect is the one in force when we send the user to the consent screen.
 */
export async function registerOAuthClient(
  spec: ProviderOAuthSpec,
  metadata: OAuthMetadata,
  redirectUri: string,
  deps?: OAuthDeps,
): Promise<string> {
  if (!metadata.registrationEndpoint) {
    throw new Error(`${spec.name} does not advertise a client registration endpoint.`);
  }
  const response = await call(deps)(metadata.registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: spec.clientName ?? DEFAULT_CLIENT_NAME,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
    }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      oauthErrorMessage(body) ?? `Client registration failed (HTTP ${response.status}).`,
    );
  }
  const clientId = stringField(body, "client_id");
  if (!clientId) throw new Error(`${spec.name} returned no client_id.`);
  return clientId;
}

/** Registers a client and builds the URL the user's browser must open. */
export async function beginLogin(
  spec: ProviderOAuthSpec,
  redirectUri: string,
  deps?: OAuthDeps,
): Promise<PendingLogin> {
  const metadata = await discoverOAuth(spec, deps);
  const clientId = await registerOAuthClient(spec, metadata, redirectUri, deps);

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
  authorizeUrl.searchParams.set("scope", spec.scope);

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
export async function completeLogin(
  spec: ProviderOAuthSpec,
  pending: PendingLogin,
  code: string,
  deps?: OAuthDeps,
): Promise<OAuthTokens> {
  return tokenRequest(
    spec,
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
 * Trades a refresh token for a fresh access token. Treat the returned
 * `refreshToken` as replacing the one passed in — providers rotate on use.
 */
export async function refreshOAuthTokens(
  spec: ProviderOAuthSpec,
  clientId: string,
  refreshToken: string,
  deps?: OAuthDeps,
): Promise<OAuthTokens> {
  return tokenRequest(
    spec,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }),
    deps,
  );
}

async function tokenRequest(
  spec: ProviderOAuthSpec,
  body: URLSearchParams,
  deps?: OAuthDeps,
): Promise<OAuthTokens> {
  const metadata = await discoverOAuth(spec, deps);
  const response = await call(deps)(metadata.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      oauthErrorMessage(parsed) ?? `${spec.name} token request failed (HTTP ${response.status}).`,
    );
  }

  const accessToken = stringField(parsed, "access_token");
  if (!accessToken) throw new Error(`${spec.name} returned no access token.`);
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
export class LoginSessions {
  private readonly pending = new Map<string, PendingLogin>();

  constructor(private readonly now: () => number = Date.now) {}

  remember(login: PendingLogin): void {
    this.sweep();
    this.pending.set(login.state, login);
  }

  /** Returns and forgets the login for `state`; a code is only redeemable once. */
  take(state: string): PendingLogin | undefined {
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
export function loopbackCallbackUrl(
  spec: ProviderOAuthSpec,
  host: string | undefined,
): string {
  const hostname = host?.trim().replace(/^\[|\]$/g, "").split(":")[0];
  if (!host || !hostname || !isLoopbackHost(hostname)) {
    throw new Error(
      `${spec.name} sign-in requires a loopback address (localhost or 127.0.0.1).`,
    );
  }
  return `http://${host}${spec.callbackPath}`;
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
