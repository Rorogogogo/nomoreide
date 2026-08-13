import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  refreshVercelOAuthTokens,
  VERCEL_TOKEN_REFRESH_SKEW_MS,
  type VercelOAuthDeps,
  type VercelOAuthTokens,
} from "./vercel-oauth.js";
import type { NoMoreIdeConfig, ProviderConnection } from "./types.js";

/** Provider id this integration stores its connection under. */
export const VERCEL_PROVIDER_ID = "vercel";

/**
 * Where a Vercel token comes from.
 *
 * Mirrors the GitHub integration's "gh CLI account or pasted token" split: if
 * the user has already run `vercel login`, reuse that session rather than
 * asking them to mint a personal access token. CLI tokens are *never* copied
 * into NoMoreIDE's config — they are re-read from the CLI's own auth file at
 * use time, so `vercel logout` revokes our access too.
 */
export interface ResolvedVercelCredential {
  source: "cli" | "stored" | "oauth";
  token: string;
  /** Team scope; absent means the personal account. */
  teamId?: string;
  teamSlug?: string;
}

export interface ResolveVercelOptions {
  /**
   * Persists tokens produced by a refresh. Omitted by read-only callers (and
   * tests), which then simply use the refreshed token without saving it.
   */
  onTokensRefreshed?: (tokens: VercelOAuthTokens) => Promise<void>;
  oauthDeps?: VercelOAuthDeps;
}

export interface VercelCliSession {
  token: string;
  /** The CLI's currently selected scope, used as the default team. */
  currentTeam?: string;
}

export interface VercelCliStatus {
  available: boolean;
  error?: string;
}

/**
 * Candidate locations of the Vercel CLI's `auth.json`, newest convention
 * first. The CLI resolves these through `xdg-app-paths` under the app name
 * `com.vercel.cli`; the trailing entries are the pre-rename legacy paths that
 * long-lived installs still carry.
 */
export function vercelCliDataDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  // `env.HOME` rather than `homedir()` so an overridden environment redirects
  // every candidate, not just the XDG one — otherwise a caller that points
  // XDG_DATA_HOME somewhere still falls through to the real user's login.
  const home = env.HOME?.trim() || homedir();
  const dirs: string[] = [];
  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  if (xdgDataHome) dirs.push(join(xdgDataHome, "com.vercel.cli"));
  if (process.platform === "darwin") {
    dirs.push(join(home, "Library", "Application Support", "com.vercel.cli"));
  } else if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData) dirs.push(join(localAppData, "com.vercel.cli", "Data"));
  }
  dirs.push(join(home, ".local", "share", "com.vercel.cli"));
  dirs.push(join(home, ".vercel"));
  dirs.push(join(home, ".now"));
  return dirs;
}

/**
 * The Vercel CLI's stored login, or null when the user has not run
 * `vercel login` on this machine. Best-effort by design: an unreadable or
 * malformed auth file is "not logged in", never an error the UI has to explain.
 */
export async function readVercelCliSession(
  env: NodeJS.ProcessEnv = process.env,
): Promise<VercelCliSession | null> {
  for (const dir of vercelCliDataDirs(env)) {
    const token = await readJsonField(join(dir, "auth.json"), "token");
    if (!token) continue;
    const currentTeam = await readJsonField(join(dir, "config.json"), "currentTeam");
    return { token, currentTeam: currentTeam || undefined };
  }
  return null;
}

export async function vercelCliStatus(
  env: NodeJS.ProcessEnv = process.env,
): Promise<VercelCliStatus> {
  const session = await readVercelCliSession(env);
  if (session) return { available: true };
  return {
    available: false,
    error: "No Vercel CLI login found. Run `vercel login`, or paste a token instead.",
  };
}

/**
 * The token the Vercel integration should use, given the saved connection.
 *
 * Throws with an actionable message rather than returning null: every caller
 * needs a token to do anything, and the message is what the UI shows.
 */
export async function resolveVercelCredential(
  config: NoMoreIdeConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveVercelOptions = {},
): Promise<ResolvedVercelCredential> {
  const connection = config.connections[VERCEL_PROVIDER_ID];
  const scope = { teamId: connection?.scopeId, teamSlug: connection?.scopeSlug };

  if (connection?.source === "oauth") {
    return { source: "oauth", token: await oauthAccessToken(connection, options), ...scope };
  }

  if (connection?.source === "stored") {
    if (!connection.token) {
      throw new Error("No Vercel token stored. Reconnect Vercel with a token.");
    }
    return { source: "stored", token: connection.token, ...scope };
  }

  const session = await readVercelCliSession(env);
  if (session) {
    return {
      source: "cli",
      token: session.token,
      // An explicitly chosen scope wins; otherwise inherit whatever scope the
      // CLI is pointed at, so the dashboard opens on the same team `vercel` uses.
      teamId: connection?.scopeId ?? session.currentTeam,
      teamSlug: connection?.scopeSlug,
    };
  }

  throw new Error(
    connection?.source === "cli"
      ? "The Vercel CLI is no longer logged in. Run `vercel login`, sign in to Vercel, or connect with a token."
      : "Vercel is not connected. Sign in to Vercel, run `vercel login`, or add a Vercel token.",
  );
}

/**
 * A valid access token for an `oauth` connection, refreshing it first when it
 * has expired (or is about to). The refreshed pair is handed back to
 * `onTokensRefreshed` so the rotated refresh token replaces the spent one.
 */
async function oauthAccessToken(
  connection: ProviderConnection,
  options: ResolveVercelOptions,
): Promise<string> {
  const expiresAt = connection.expiresAt ?? 0;
  const stillFresh = connection.token && Date.now() + VERCEL_TOKEN_REFRESH_SKEW_MS < expiresAt;
  if (stillFresh && connection.token) return connection.token;

  if (!connection.refreshToken || !connection.clientId) {
    throw new Error("Your Vercel sign-in has expired. Sign in to Vercel again.");
  }

  let tokens: VercelOAuthTokens;
  try {
    tokens = await refreshVercelOAuthTokens(
      connection.clientId,
      connection.refreshToken,
      options.oauthDeps,
    );
  } catch (cause) {
    throw new Error(
      `Could not renew your Vercel sign-in (${cause instanceof Error ? cause.message : String(cause)}). Sign in to Vercel again.`,
    );
  }
  await options.onTokensRefreshed?.(tokens);
  return tokens.accessToken;
}

/** The connection stripped of its secrets, safe to return over the API. */
export function publicVercelConnection(
  connection: ProviderConnection | undefined,
): Omit<ProviderConnection, "token" | "refreshToken"> | undefined {
  if (!connection) return undefined;
  const { token: _token, refreshToken: _refreshToken, ...rest } = connection;
  return rest;
}

async function readJsonField(path: string, field: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const value = parsed[field];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}
