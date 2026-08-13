import { readFile } from "node:fs/promises";
import type { NoMoreIdeConfig, ProviderConnection } from "../types.js";
import {
  clock,
  refreshOAuthTokens,
  TOKEN_REFRESH_SKEW_MS,
  type OAuthDeps,
  type OAuthTokens,
  type ProviderOAuthSpec,
} from "./oauth.js";

/**
 * Where a provider token comes from, and the policy for getting one.
 *
 * The three-source model (`cli` | `stored` | `oauth`) came from Vercel but is
 * not Vercel-shaped: Cloudflare has `wrangler login` + an API token + OAuth,
 * and a provider with only an API key simply declares `stored`. What generalizes
 * with it is the rule that makes the `cli` source safe —
 *
 *   **CLI tokens are never copied into NoMoreIDE's config.** They are re-read
 *   from the vendor CLI's own auth file at use time, so `<vendor> logout`
 *   revokes our access too.
 *
 * — which is why {@link ProviderAuthSpec.cliSession} is a read hook rather than
 * something the caller may persist. A provider cannot opt out of that policy.
 */
export interface ProviderCredential {
  source: "cli" | "stored" | "oauth";
  token: string;
  /** Account scope — a Vercel team, a Cloudflare account. Absent means the provider's default. */
  scopeId?: string;
  scopeSlug?: string;
}

export interface ProviderCliSession {
  token: string;
  /** The vendor CLI's currently selected scope, used as the default. */
  currentScope?: string;
}

export interface ProviderCliStatus {
  available: boolean;
  error?: string;
}

/**
 * The user-facing text a provider must supply, in the one place a credential
 * can fail. Plain strings rather than functions because these are headed for a
 * provider manifest's `strings` block, which has to survive being JSON.
 */
export interface ProviderAuthMessages {
  /** No vendor CLI login found, offered while the user is choosing how to connect. */
  cliMissing: string;
  /** A `stored` connection whose token has gone missing. */
  noStoredToken: string;
  /** A `cli` connection whose CLI login has since gone away. */
  cliLoggedOut: string;
  /** No connection at all, and no CLI login to fall back on. */
  notConnected: string;
  /** An `oauth` connection with nothing left to refresh with. */
  signInExpired: string;
  /** A refresh that failed. `{error}` is replaced with the underlying message. */
  refreshFailed: string;
}

export interface ProviderAuthSpec {
  /** Key this provider's connection is stored under in `config.connections`. */
  id: string;
  /** Display name, used verbatim in messages. */
  name: string;
  /**
   * Reads the vendor CLI's stored login. Omitted by providers with no CLI, in
   * which case the `cli` source is simply never available.
   */
  cliSession?: (env: NodeJS.ProcessEnv) => Promise<ProviderCliSession | null>;
  /** Omitted by providers with no browser sign-in. */
  oauth?: ProviderOAuthSpec;
  messages: ProviderAuthMessages;
}

export interface ResolveCredentialOptions {
  /**
   * Persists tokens produced by a refresh. Omitted by read-only callers (and
   * tests), which then simply use the refreshed token without saving it.
   */
  onTokensRefreshed?: (tokens: OAuthTokens) => Promise<void>;
  oauthDeps?: OAuthDeps;
}

/** Whether the vendor CLI is logged in, and what to tell the user when it isn't. */
export async function providerCliStatus(
  spec: ProviderAuthSpec,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderCliStatus> {
  const session = await spec.cliSession?.(env);
  if (session) return { available: true };
  return { available: false, error: spec.messages.cliMissing };
}

/**
 * The token this provider should use, given the saved connection.
 *
 * Throws with an actionable message rather than returning null: every caller
 * needs a token to do anything, and the message is what the UI shows.
 */
export async function resolveProviderCredential(
  spec: ProviderAuthSpec,
  config: NoMoreIdeConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveCredentialOptions = {},
): Promise<ProviderCredential> {
  const connection = config.connections[spec.id];
  const scope = { scopeId: connection?.scopeId, scopeSlug: connection?.scopeSlug };

  if (connection?.source === "oauth") {
    return { source: "oauth", token: await oauthAccessToken(spec, connection, options), ...scope };
  }

  if (connection?.source === "stored") {
    if (!connection.token) throw new Error(spec.messages.noStoredToken);
    return { source: "stored", token: connection.token, ...scope };
  }

  const session = await spec.cliSession?.(env);
  if (session) {
    return {
      source: "cli",
      token: session.token,
      // An explicitly chosen scope wins; otherwise inherit whatever scope the
      // CLI is pointed at, so the dashboard opens on the same scope the vendor
      // CLI uses.
      scopeId: connection?.scopeId ?? session.currentScope,
      scopeSlug: connection?.scopeSlug,
    };
  }

  throw new Error(
    connection?.source === "cli" ? spec.messages.cliLoggedOut : spec.messages.notConnected,
  );
}

/**
 * A valid access token for an `oauth` connection, refreshing it first when it
 * has expired (or is about to). The refreshed pair is handed back to
 * `onTokensRefreshed` so a rotated refresh token replaces the spent one.
 */
async function oauthAccessToken(
  spec: ProviderAuthSpec,
  connection: ProviderConnection,
  options: ResolveCredentialOptions,
): Promise<string> {
  const expiresAt = connection.expiresAt ?? 0;
  const stillFresh =
    connection.token && clock(options.oauthDeps) + TOKEN_REFRESH_SKEW_MS < expiresAt;
  if (stillFresh && connection.token) return connection.token;

  if (!spec.oauth || !connection.refreshToken || !connection.clientId) {
    throw new Error(spec.messages.signInExpired);
  }

  let tokens: OAuthTokens;
  try {
    tokens = await refreshOAuthTokens(
      spec.oauth,
      connection.clientId,
      connection.refreshToken,
      options.oauthDeps,
    );
  } catch (cause) {
    throw new Error(
      spec.messages.refreshFailed.replace(
        "{error}",
        cause instanceof Error ? cause.message : String(cause),
      ),
    );
  }
  await options.onTokensRefreshed?.(tokens);
  return tokens.accessToken;
}

/** The connection stripped of its secrets, safe to return over the API. */
export function publicProviderConnection(
  connection: ProviderConnection | undefined,
): Omit<ProviderConnection, "token" | "refreshToken"> | undefined {
  if (!connection) return undefined;
  const { token: _token, refreshToken: _refreshToken, ...rest } = connection;
  return rest;
}

/**
 * Reads `field` from the JSON at `path`, or undefined if anything goes wrong.
 *
 * Shared because every vendor CLI stores its login the same way — a JSON file
 * with a token field — and a missing or malformed one must read as "not logged
 * in", never as an error the UI has to explain.
 */
export async function readJsonField(
  path: string,
  field: string,
): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const value = parsed[field];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}
