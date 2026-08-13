import { homedir } from "node:os";
import { join } from "node:path";
import {
  providerCliStatus,
  publicProviderConnection,
  readJsonField,
  resolveProviderCredential,
  type ProviderAuthSpec,
  type ProviderCliSession,
  type ProviderCliStatus,
  type ProviderCredential,
  type ResolveCredentialOptions,
} from "./providers/credentials.js";
import { VERCEL_OAUTH } from "./vercel-oauth.js";
import type { NoMoreIdeConfig, ProviderConnection } from "./types.js";

/** Provider id this integration stores its connection under. */
export const VERCEL_PROVIDER_ID = "vercel";

export type ResolvedVercelCredential = ProviderCredential;
export type VercelCliSession = ProviderCliSession;
export type VercelCliStatus = ProviderCliStatus;
export type ResolveVercelOptions = ResolveCredentialOptions;

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
    const currentScope = await readJsonField(join(dir, "config.json"), "currentTeam");
    return { token, currentScope: currentScope || undefined };
  }
  return null;
}

/**
 * Vercel's half of the shared credential resolver: where the CLI keeps its
 * login, and the six messages the UI shows when there is no usable token.
 *
 * The policy around all of it — three sources, CLI tokens re-read rather than
 * copied, an explicit scope beating the CLI's own — is in
 * `providers/credentials.ts` and is deliberately not restatable here.
 */
export const VERCEL_AUTH: ProviderAuthSpec = {
  id: VERCEL_PROVIDER_ID,
  name: "Vercel",
  cliSession: readVercelCliSession,
  oauth: VERCEL_OAUTH,
  messages: {
    cliMissing: "No Vercel CLI login found. Run `vercel login`, or paste a token instead.",
    noStoredToken: "No Vercel token stored. Reconnect Vercel with a token.",
    cliLoggedOut:
      "The Vercel CLI is no longer logged in. Run `vercel login`, sign in to Vercel, or connect with a token.",
    notConnected:
      "Vercel is not connected. Sign in to Vercel, run `vercel login`, or add a Vercel token.",
    signInExpired: "Your Vercel sign-in has expired. Sign in to Vercel again.",
    refreshFailed: "Could not renew your Vercel sign-in ({error}). Sign in to Vercel again.",
  },
};

export function vercelCliStatus(
  env: NodeJS.ProcessEnv = process.env,
): Promise<VercelCliStatus> {
  return providerCliStatus(VERCEL_AUTH, env);
}

/**
 * The token the Vercel integration should use, given the saved connection.
 *
 * Throws with an actionable message rather than returning null: every caller
 * needs a token to do anything, and the message is what the UI shows.
 */
export function resolveVercelCredential(
  config: NoMoreIdeConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveVercelOptions = {},
): Promise<ResolvedVercelCredential> {
  return resolveProviderCredential(VERCEL_AUTH, config, env, options);
}

/** The connection stripped of its secrets, safe to return over the API. */
export function publicVercelConnection(
  connection: ProviderConnection | undefined,
): Omit<ProviderConnection, "token" | "refreshToken"> | undefined {
  return publicProviderConnection(connection);
}
