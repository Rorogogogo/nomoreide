/**
 * Where a provider's API calls go — the vendor, unless the environment names a
 * loopback stand-in.
 *
 * This is the same seam `githubApiBase()` opened for the GitHub tools, hoisted
 * into the provider layer because two providers now need it. It exists so the
 * deploy tools can be exercised — and diffed against the native runtime —
 * without a token, a network, or an account that really exists.
 *
 * **The override is loopback-only, and that is the whole safety argument.** A
 * value naming any other host is ignored rather than rejected, so a stray or
 * hostile variable in an inherited environment cannot redirect a
 * credential-bearing request off the machine. `http:` is accepted alongside
 * `https:` because a loopback stub has no certificate and needs none: the
 * request never leaves the kernel's loopback interface.
 */

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]", "::1"];

/**
 * @param variable Environment variable naming the stand-in, e.g. `NOMOREIDE_VERCEL_API_BASE`.
 * @param fallback The vendor's real base URL, returned whenever the override is
 *   absent, unparseable, or not loopback.
 */
export function providerApiBase(variable: string, fallback: string): string {
  const override = process.env[variable]?.trim();
  if (!override) return fallback;
  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    return fallback;
  }
  if (!LOOPBACK.includes(parsed.hostname)) return fallback;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return fallback;
  return override.replace(/\/+$/, "");
}

/** The hostname a scoped `fetch` must admit for a base URL — the allowlist follows the base. */
export function providerApiHost(base: string): string {
  return new URL(base).hostname;
}
