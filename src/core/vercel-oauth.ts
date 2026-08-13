import {
  beginLogin,
  completeLogin,
  discoverOAuth,
  loopbackCallbackUrl,
  refreshOAuthTokens,
  resetOAuthDiscoveryCache,
  type OAuthDeps,
  type OAuthMetadata,
  type OAuthTokens,
  type PendingLogin,
  type ProviderOAuthSpec,
} from "./providers/oauth.js";

/**
 * Vercel's half of the shared browser sign-in — four constants and the
 * bindings that pin `providers/oauth.ts` to them.
 *
 * Everything else (PKCE, dynamic client registration, the loopback redirect,
 * rotating refresh, the pending-login store) lives in the shared module and is
 * not Vercel-specific.
 *
 * Why not the device flow we use for GitHub: Vercel restricts
 * `urn:ietf:params:oauth:grant-type:device_code` to its own first-party
 * clients. A client we register is refused with `unauthorized_client`, so the
 * loopback flow is the only browser sign-in available to us.
 *
 * `offline_access` is **required** here specifically — without it Vercel's
 * grant comes back with no refresh token and dies after an hour.
 */
export const VERCEL_OAUTH: ProviderOAuthSpec = {
  name: "Vercel",
  issuer: "https://vercel.com",
  scope: "offline_access",
  callbackPath: "/api/vercel/oauth/callback",
};

export type VercelOAuthMetadata = OAuthMetadata;
export type VercelOAuthTokens = OAuthTokens;
export type VercelPendingLogin = PendingLogin;
export type VercelOAuthDeps = OAuthDeps;

export { LoginSessions as VercelLoginSessions, TOKEN_REFRESH_SKEW_MS as VERCEL_TOKEN_REFRESH_SKEW_MS } from "./providers/oauth.js";

/** Exposed for tests, which must not inherit another case's cached discovery. */
export function resetVercelOAuthDiscoveryCache(): void {
  resetOAuthDiscoveryCache(VERCEL_OAUTH.issuer);
}

export function discoverVercelOAuth(deps?: VercelOAuthDeps): Promise<VercelOAuthMetadata> {
  return discoverOAuth(VERCEL_OAUTH, deps);
}

/** Registers a client and builds the URL the user's browser must open. */
export function beginVercelLogin(
  redirectUri: string,
  deps?: VercelOAuthDeps,
): Promise<VercelPendingLogin> {
  return beginLogin(VERCEL_OAUTH, redirectUri, deps);
}

/** Exchanges the authorization code the callback received for tokens. */
export function completeVercelLogin(
  pending: VercelPendingLogin,
  code: string,
  deps?: VercelOAuthDeps,
): Promise<VercelOAuthTokens> {
  return completeLogin(VERCEL_OAUTH, pending, code, deps);
}

/**
 * Trades a refresh token for a fresh access token. The returned
 * `refreshToken` replaces the one passed in — Vercel rotates on every use.
 */
export function refreshVercelOAuthTokens(
  clientId: string,
  refreshToken: string,
  deps?: VercelOAuthDeps,
): Promise<VercelOAuthTokens> {
  return refreshOAuthTokens(VERCEL_OAUTH, clientId, refreshToken, deps);
}

/** The loopback callback URL for a request that arrived on `host`. */
export function vercelCallbackUrl(host: string | undefined): string {
  return loopbackCallbackUrl(VERCEL_OAUTH, host);
}
