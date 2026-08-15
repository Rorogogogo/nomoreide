import {
  providerCliStatus,
  type ProviderAuthSpec,
  type ProviderCliSession,
  type ProviderCliStatus,
} from "./providers/credentials.js";

/** Provider id this integration stores its connection under. */
export const VULTR_PROVIDER_ID = "vultr";

/**
 * The ambient Vultr credential, or null when there is none.
 *
 * `VULTR_API_KEY` is what `vultr-cli`, Terraform's Vultr provider and Vultr's
 * own examples all read, so a machine already set up to talk to Vultr is
 * already connected as far as NoMoreIDE is concerned.
 *
 * **This is the `cli` source without a CLI login file, and that is the finding.**
 * Vercel and Cloudflare both back that source with a file the vendor's CLI
 * wrote; `vultr-cli` stores its key in `~/.vultr-cli.yaml`, which would need a
 * YAML parser to read for no benefit — the same key is in the environment
 * whenever the CLI is actually usable. What makes the source `cli` rather than
 * `stored` is not where the token lives but the policy attached to it: it is
 * re-read at use time and never copied into NoMoreIDE's config, so removing it
 * from the environment removes our access too. See `providers/credentials.ts`.
 */
export async function readVultrEnvSession(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderCliSession | null> {
  const token = env.VULTR_API_KEY?.trim() || env.VULTR_API_TOKEN?.trim();
  // No `currentScope`: a Vultr API key addresses one account and Vultr has no
  // team or sub-account to switch between, so there is no scope to inherit.
  return token ? { token } : null;
}

/**
 * Vultr's half of the shared credential resolver.
 *
 * **No `oauth` block.** Vultr's API authenticates with a personal API key only;
 * there is no authorization server to run the shared PKCE flow against. That
 * makes it the second provider to decline browser sign-in, and — with a
 * `cliSession` that reads no file — the narrowest use of the three-source model
 * so far. The model absorbing both ends of that range without changing is what
 * the sequencing in the design plan was for.
 */
export const VULTR_AUTH: ProviderAuthSpec = {
  id: VULTR_PROVIDER_ID,
  name: "Vultr",
  cliSession: readVultrEnvSession,
  messages: {
    cliMissing:
      "No VULTR_API_KEY in the environment. Export one, or paste a Vultr API key instead.",
    noStoredToken: "No Vultr API key stored. Reconnect Vultr with an API key.",
    cliLoggedOut:
      "VULTR_API_KEY is no longer set. Export it again, or connect with a Vultr API key.",
    notConnected:
      "Vultr is not connected. Add a Vultr API key, or export VULTR_API_KEY.",
    // Reachable only if a connection were somehow saved as `oauth`; Vultr never
    // creates one, so the message points at what does work.
    signInExpired: "Vultr has no browser sign-in. Connect with a Vultr API key.",
    refreshFailed: "Could not renew your Vultr credential ({error}). Add an API key.",
  },
};

export function vultrCliStatus(env: NodeJS.ProcessEnv = process.env): Promise<ProviderCliStatus> {
  return providerCliStatus(VULTR_AUTH, env);
}
