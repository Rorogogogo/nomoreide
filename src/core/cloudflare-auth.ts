import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  providerCliStatus,
  type ProviderAuthSpec,
  type ProviderCliSession,
  type ProviderCliStatus,
} from "./providers/credentials.js";

/** Provider id this integration stores its connection under. */
export const CLOUDFLARE_PROVIDER_ID = "cloudflare";

/**
 * Candidate locations of Wrangler's `config/default.toml`, newest convention
 * first. Wrangler resolves these through `xdg-app-paths` under the app name
 * `.wrangler`; the trailing entry is the pre-XDG path that long-lived installs
 * still carry, and `WRANGLER_HOME` overrides all of them.
 */
export function wranglerConfigDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  // `env.HOME` rather than `homedir()` so an overridden environment redirects
  // every candidate, not just the XDG one — otherwise a caller that points
  // XDG_CONFIG_HOME somewhere still falls through to the real user's login.
  const home = env.HOME?.trim() || homedir();
  const dirs: string[] = [];
  const wranglerHome = env.WRANGLER_HOME?.trim();
  if (wranglerHome) dirs.push(wranglerHome);
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) dirs.push(join(xdgConfigHome, ".wrangler"));
  if (process.platform === "darwin") {
    dirs.push(join(home, "Library", "Preferences", ".wrangler"));
  } else if (process.platform === "win32") {
    const appData = env.APPDATA?.trim();
    if (appData) dirs.push(join(appData, ".wrangler", "Config"));
  }
  dirs.push(join(home, ".config", ".wrangler"));
  dirs.push(join(home, ".wrangler"));
  return dirs;
}

/**
 * The ambient Cloudflare credential, or null when there is none.
 *
 * Two sources, in the order Wrangler itself prefers them:
 *
 * 1. `CLOUDFLARE_API_TOKEN` in the environment, which is how Wrangler runs in
 *    CI and in most shells that have been set up for it;
 * 2. the OAuth token `wrangler login` wrote to `config/default.toml`.
 *
 * Neither is ever copied into NoMoreIDE's config — that is the shared `cli`
 * policy, and it is what makes `wrangler logout` revoke us too.
 *
 * An expired stored token reads as "not logged in" rather than being handed
 * out: Wrangler refreshes it roughly hourly and rotates the refresh token when
 * it does, so renewing it here would invalidate Wrangler's own copy.
 */
export async function readWranglerSession(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderCliSession | null> {
  const currentScope = env.CLOUDFLARE_ACCOUNT_ID?.trim() || env.CF_ACCOUNT_ID?.trim() || undefined;
  const envToken = env.CLOUDFLARE_API_TOKEN?.trim() || env.CF_API_TOKEN?.trim();
  if (envToken) return { token: envToken, currentScope };

  for (const dir of wranglerConfigDirs(env)) {
    const config = await readTomlFields(join(dir, "config", "default.toml"));
    const token = config.oauth_token;
    if (!token) continue;
    const expiresAt = Date.parse(config.expiration_time ?? "");
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return null;
    return { token, currentScope };
  }
  return null;
}

/**
 * The top-level `key = "value"` pairs of a TOML file, or `{}` if anything goes
 * wrong.
 *
 * Deliberately not a TOML parser and deliberately not shared: Wrangler's auth
 * file is flat and quoted, and the only reason this exists rather than
 * `readJsonField` is that Cloudflare's CLI happens to store its login as TOML.
 * A malformed or missing file must read as "not logged in", never as an error
 * the UI has to explain.
 */
async function readTomlFields(path: string): Promise<Record<string, string>> {
  const fields: Record<string, string> = {};
  try {
    const raw = await readFile(path, "utf8");
    for (const line of raw.split("\n")) {
      // Stop at the first table header: everything Wrangler stores is top-level,
      // and a nested table's keys are not the same keys.
      if (/^\s*\[/.test(line)) break;
      const match = /^\s*([A-Za-z_][\w-]*)\s*=\s*"([^"]*)"\s*$/.exec(line);
      if (match?.[2]) fields[match[1]] = match[2];
    }
  } catch {
    /* an unreadable file is "not logged in" */
  }
  return fields;
}

/**
 * Cloudflare's half of the shared credential resolver.
 *
 * **No `oauth` block — because of how our flow works, not because Cloudflare
 * has no OAuth.** The shared `providers/oauth.ts` mints its own client at
 * runtime via dynamic client registration (RFC 7591), which is what lets
 * NoMoreIDE ship no client id at all. Cloudflare has no registration endpoint,
 * so `registerOAuthClient()` would throw before a browser ever opened.
 *
 * That is a narrower obstacle than it was. Since 2026-06-03 Cloudflare lets
 * anyone register their own OAuth client, including a *public* one using
 * authorization code + PKCE (S256) with no client secret — the shape a
 * self-hosted app needs. Adopting it is therefore possible, but it is a change
 * of model rather than a new provider entry: NoMoreIDE would ship a
 * pre-registered client id, which `ProviderAuthSpec.oauth` currently has no way
 * to express, and public visibility additionally requires a verified client
 * domain and is irreversible once granted. Unverified: whether a loopback
 * redirect URI is accepted for these clients, which our flow depends on.
 *
 * Until then Cloudflare connects with an API token or by inheriting Wrangler's
 * own login. The three-source model survives contact with provider #2; only
 * this provider's subset of it is smaller.
 *
 * @see docs/plans/2026-08-13-provider-registry-design.md §11
 */
export const CLOUDFLARE_AUTH: ProviderAuthSpec = {
  id: CLOUDFLARE_PROVIDER_ID,
  name: "Cloudflare",
  cliSession: readWranglerSession,
  messages: {
    cliMissing:
      "No Wrangler login found. Run `wrangler login`, or paste a Cloudflare API token instead.",
    noStoredToken: "No Cloudflare token stored. Reconnect Cloudflare with an API token.",
    cliLoggedOut:
      "Wrangler is no longer logged in. Run `wrangler login` again, or connect with a Cloudflare API token.",
    notConnected:
      "Cloudflare is not connected. Run `wrangler login`, or add a Cloudflare API token.",
    // Reachable only if a connection were somehow saved as `oauth`; Cloudflare
    // never creates one, so the message points at what does work.
    signInExpired: "Cloudflare has no browser sign-in. Connect with a Cloudflare API token.",
    refreshFailed: "Could not renew your Cloudflare credential ({error}). Add an API token.",
  },
};

export function cloudflareCliStatus(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderCliStatus> {
  return providerCliStatus(CLOUDFLARE_AUTH, env);
}
