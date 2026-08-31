/**
 * The provider egress boundary — a `fetch` scoped to a provider's declared
 * `api.hosts`.
 *
 * §6 of `docs/plans/2026-08-13-provider-registry-design.md` calls `api.hosts`
 * "the security boundary", and §11 records that the boundary existed only in
 * prose: all three managers called global `fetch` directly. This is the module
 * that makes it real, and it is gate item 3 of the freeze decision.
 *
 * **Why it matters even while every provider is in-tree.** A provider
 * necessarily receives credentials and runs inside the daemon — the same
 * process holding GitHub tokens, `db-write.ts` access and process-spawn
 * ability. In-tree the code is reviewed and the egress auditable, so this buys
 * documentation rather than protection. The moment a provider is *downloaded*,
 * it is the entire barrier. Landing it now means the three in-tree providers
 * prove the shape before anything third-party depends on it.
 *
 * **The hole it closes today.** All three `xRequest` helpers accept an absolute
 * URL (`path.startsWith("http")`) and skip the base URL entirely. That escape
 * exists for pagination cursors, and it is exactly what provider code would use
 * to send an `Authorization`-bearing request anywhere it liked. The allowlist is
 * checked against the *final* URL, so the escape no longer escapes.
 */

/**
 * The egress allowlist a provider manifest declares.
 *
 * Hosts are matched **exactly** — no wildcards, deliberately. Every vendor here
 * has a customer-controlled subdomain space (`*.vercel.app`, `*.pages.dev`), so
 * a pattern like `*.vercel.com` reads as a convenience while quietly admitting
 * hosts the vendor does not control. A provider that genuinely needs a second
 * host lists the second host.
 */
export interface ProviderApiSpec {
  /** Bare hostnames, no scheme and no path: `["api.vercel.com"]`. */
  hosts: string[];
}

/** A `fetch` that can only reach one provider's declared hosts. */
export type ProviderFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * A refused request. Distinct from every `*ApiError` because nothing was sent —
 * there is no status and no vendor to blame, only a provider asking for
 * something its manifest does not declare.
 */
export class ProviderEgressError extends Error {
  constructor(
    message: string,
    public readonly providerId: string,
    public readonly url: string,
  ) {
    super(message);
    this.name = "ProviderEgressError";
  }
}

/**
 * A redirect chain is followed by hand so that every hop is checked.
 *
 * The default `redirect: "follow"` would let an allowlisted host bounce a
 * credential-bearing request to an unlisted one, and open redirects on vendor
 * APIs are common enough that this is not a theoretical concern. Each hop goes
 * back through the allowlist; the cap stops a redirect loop from hanging a
 * dashboard request.
 */
const MAX_REDIRECTS = 5;

/** Read at call time, not at module load, so a test's `vi.stubGlobal` still wins. */
const globalFetch: ProviderFetch = (url, init) => fetch(url, init);

/**
 * A `fetch` for one provider, refusing anything its manifest does not declare.
 *
 * Takes the manifest rather than a bare host list so the id in an error message
 * and the allowlist it was checked against cannot drift apart.
 */
export function createProviderFetch(
  manifest: { id: string; api: ProviderApiSpec },
  base: ProviderFetch = globalFetch,
): ProviderFetch {
  const { id } = manifest;
  const allowed = new Set(manifest.api.hosts.map((host) => host.trim().toLowerCase()));

  const send = async (input: string | URL, init: RequestInit | undefined, hop: number) => {
    const url = assertAllowed(id, allowed, input);
    // `manual` so a 3xx comes back as a response to inspect rather than being
    // followed past the allowlist.
    const response = await base(url, { ...init, redirect: "manual" });

    const location = redirectTarget(response);
    if (!location) return response;
    if (hop >= MAX_REDIRECTS) {
      throw new ProviderEgressError(
        `Provider "${id}" was redirected more than ${MAX_REDIRECTS} times from ${url.href}.`,
        id,
        url.href,
      );
    }
    return send(new URL(location, url), afterRedirect(init, response.status), hop + 1);
  };

  return (input, init) => send(input, init, 0);
}

/** The URL a response redirects to, or null when it is not a redirect. */
function redirectTarget(response: Response): string | null {
  if (response.status < 300 || response.status > 399) return null;
  return response.headers.get("location");
}

/**
 * How a request changes across a redirect, per the Fetch standard: 303 always
 * becomes a GET, 301/302 turn a POST into one, and 307/308 preserve both method
 * and body.
 */
function afterRedirect(init: RequestInit | undefined, status: number): RequestInit | undefined {
  const method = (init?.method ?? "GET").toUpperCase();
  const downgrades = status === 303 || ((status === 301 || status === 302) && method === "POST");
  if (!downgrades) return init;
  const { body: _body, ...rest } = init ?? {};
  return { ...rest, method: "GET" };
}

/** Hosts that cannot leave the machine, and so need no transport encryption. */
function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

/** The check itself. Throws before anything is sent, so a refused call leaks nothing. */
function assertAllowed(providerId: string, allowed: Set<string>, input: string | URL): URL {
  let url: URL;
  try {
    url = input instanceof URL ? input : new URL(String(input));
  } catch {
    throw new ProviderEgressError(
      `Provider "${providerId}" asked for a URL that is not absolute: ${String(input)}`,
      providerId,
      String(input),
    );
  }

  // Every provider API is HTTPS, and the schemes this rules out are the
  // interesting ones: `file:` reads the disk, `data:` smuggles a payload past a
  // host check, and `http:` puts a token on the wire in clear text.
  //
  // The one exception is a loopback host, which is only ever reachable because
  // `providerApiBase()` accepted an override naming one — and a request that
  // never leaves the loopback interface is not on a wire to be read. Narrowing
  // it to loopback is what keeps this from becoming a general `http:` opening.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new ProviderEgressError(
      `Provider "${providerId}" may only use https, not ${url.protocol.replace(":", "")}: ${url.href}`,
      providerId,
      url.href,
    );
  }

  if (!allowed.has(url.hostname.toLowerCase())) {
    throw new ProviderEgressError(
      `Provider "${providerId}" is not allowed to reach ${url.hostname}. ` +
        `Its manifest declares: ${[...allowed].join(", ") || "no hosts"}.`,
      providerId,
      url.href,
    );
  }

  return url;
}
