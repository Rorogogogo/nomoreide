/**
 * Bearer-token manager for the profile registry: reads the stored access
 * token, transparently refreshes it once on a 401, and persists rotated
 * tokens back to the registry config file.
 */
import {
  createRegistryConfigService,
  resolveRegistryApiBaseUrl,
  resolveRegistryApiToken,
  type RegistryConfigOptions,
  type RegistryConfigService,
} from "./registry-config.js";

export interface RegistryTokenManager {
  /** Current access token, or null when signed out. */
  getAccessToken(): Promise<string | null>;
  /** Authenticated fetch that refreshes once on 401 and retries. */
  authenticatedFetch(pathOrUrl: string, init?: RequestInit): Promise<Response>;
  /** Persist tokens after a fresh sign-in. */
  saveTokens(input: { accessToken: string; refreshToken?: string }): Promise<void>;
  /** Sign out: drop both tokens. */
  clear(): Promise<void>;
}

export interface RegistryTokenManagerOptions extends RegistryConfigOptions {
  configService?: RegistryConfigService;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
}

export function createRegistryTokenManager(
  options: RegistryTokenManagerOptions = {},
): RegistryTokenManager {
  const config = options.configService ?? createRegistryConfigService(options);
  const fetchImpl = options.fetch ?? fetch;
  let refreshInFlight: Promise<string | null> | null = null;

  async function apiBase(): Promise<string> {
    return (
      options.apiBaseUrl ??
      (await resolveRegistryApiBaseUrl({ ...options, configService: config }))
    ).replace(/\/$/, "");
  }

  async function readAccessToken(): Promise<string | null> {
    const resolved = await resolveRegistryApiToken({ ...options, configService: config });
    return resolved?.token ?? null;
  }

  async function refresh(): Promise<string | null> {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      const refreshToken = (await config.get("apiRefreshToken")) ?? null;
      if (!refreshToken) return null;
      const res = await fetchImpl(`${await apiBase()}/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (!res.ok) {
        // Refresh token is dead — drop both so status reports signed-out.
        await config.unset("apiRefreshToken");
        await config.unset("apiToken");
        return null;
      }
      const data = (await res.json()) as { access_token: string; refresh_token?: string };
      await config.set("apiToken", data.access_token);
      if (data.refresh_token) await config.set("apiRefreshToken", data.refresh_token);
      return data.access_token;
    })().finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  }

  return {
    getAccessToken: readAccessToken,

    async saveTokens({ accessToken, refreshToken }) {
      await config.set("apiToken", accessToken);
      if (refreshToken) await config.set("apiRefreshToken", refreshToken);
    },

    async clear() {
      await config.unset("apiToken");
      await config.unset("apiRefreshToken");
    },

    async authenticatedFetch(pathOrUrl, init = {}) {
      const url = pathOrUrl.startsWith("http")
        ? pathOrUrl
        : `${await apiBase()}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;

      const send = (token: string | null) => {
        const headers = new Headers(init.headers);
        if (token) headers.set("authorization", `Bearer ${token}`);
        return fetchImpl(url, { ...init, headers });
      };

      const first = await send(await readAccessToken());
      if (first.status !== 401) return first;

      const refreshed = await refresh();
      if (!refreshed) return first;
      return send(refreshed);
    },
  };
}
