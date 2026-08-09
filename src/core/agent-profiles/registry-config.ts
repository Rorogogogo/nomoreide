/**
 * Profile registry configuration. Credentials and target URLs live in
 * `~/.nomoreide/config.json` and honor the `NOMOREIDE_*` environment variables.
 *
 * The registry began life as the brainctl platform, so every lookup falls back
 * to the old `~/.brainctl/config.json` and `BRAINCTL_*` names: an existing
 * brainctl sign-in keeps working, and the first write migrates it to the new
 * path. The old names are the fallback, never the override — otherwise a stale
 * `BRAINCTL_API_BASE_URL` left in a shell profile would silently win.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const DEFAULT_REGISTRY_API_BASE_URL = "https://api.nomoreide.com";
export const DEFAULT_REGISTRY_FRONTEND_URL = "https://registry.nomoreide.com";

/**
 * The pre-rename default. Still serving the same API — every CLI published
 * before the rename has it compiled in — so it is a real production target, not
 * a custom one.
 */
export const LEGACY_REGISTRY_API_BASE_URL = "https://api.brainctl.net";
export const LEGACY_REGISTRY_FRONTEND_URL = "https://www.brainctl.net";

/**
 * API base → registry web UI, for the hosts we actually run. Without the legacy
 * entry an `api.brainctl.net` left in a config would fall through to the
 * `api.` → `app.` guess below and resolve to `app.brainctl.net`, which does not
 * exist.
 */
const KNOWN_REGISTRY_FRONTENDS: ReadonlyMap<string, string> = new Map([
  [DEFAULT_REGISTRY_API_BASE_URL, DEFAULT_REGISTRY_FRONTEND_URL],
  [LEGACY_REGISTRY_API_BASE_URL, LEGACY_REGISTRY_FRONTEND_URL],
]);

/**
 * Reads `NOMOREIDE_<suffix>`, falling back to the pre-rename `BRAINCTL_<suffix>`.
 */
function readBrandedEnv(
  env: NodeJS.ProcessEnv,
  suffix: string,
): string | undefined {
  return env[`NOMOREIDE_${suffix}`] ?? env[`BRAINCTL_${suffix}`];
}

export type RegistryConfigKey =
  | "apiBaseUrl"
  | "apiToken"
  | "apiRefreshToken"
  | "apiFrontendUrl";

export interface RegistryConfig {
  apiBaseUrl?: string;
  apiToken?: string;
  apiRefreshToken?: string;
  apiFrontendUrl?: string;
}

export type RegistryApiTargetSource = "env" | "config" | "default";
export type RegistryApiTargetMode = "local" | "prod" | "custom";

export interface RegistryApiTarget {
  apiBaseUrl: string;
  source: RegistryApiTargetSource;
  mode: RegistryApiTargetMode;
}

export interface RegistryConfigOptions {
  /** Injectable for tmpdir tests. */
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RegistryConfigService {
  path(): string;
  get(key: RegistryConfigKey): Promise<string | undefined>;
  set(key: RegistryConfigKey, value: string): Promise<void>;
  unset(key: RegistryConfigKey): Promise<void>;
}

/** Where config is written, and read from first. */
export function registryConfigPath(options: RegistryConfigOptions = {}): string {
  const env = options.env ?? process.env;
  return (
    options.configPath ??
    readBrandedEnv(env, "CONFIG_PATH") ??
    path.join(readBrandedEnv(env, "HOME") ?? homedir(), ".nomoreide", "config.json")
  );
}

/**
 * Pre-rename location, read only when {@link registryConfigPath} has no file
 * yet. Returns null when the caller pinned an explicit path or the resolved
 * path is already the legacy one — there is nothing to fall back to.
 */
export function legacyRegistryConfigPath(
  options: RegistryConfigOptions = {},
): string | null {
  const env = options.env ?? process.env;
  if (options.configPath ?? readBrandedEnv(env, "CONFIG_PATH")) return null;
  return path.join(readBrandedEnv(env, "HOME") ?? homedir(), ".brainctl", "config.json");
}

export function createRegistryConfigService(
  options: RegistryConfigOptions = {},
): RegistryConfigService {
  const filePath = registryConfigPath(options);
  const legacyPath = legacyRegistryConfigPath(options);

  async function readFrom(candidate: string): Promise<RegistryConfig | null> {
    let source: string;
    try {
      source = await readFile(candidate, "utf8");
    } catch {
      return null;
    }
    try {
      return normalizeConfig(JSON.parse(source) as Partial<RegistryConfig> | null);
    } catch (error) {
      throw new Error(
        `Invalid registry config at ${candidate}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Falls back to the pre-rename file so an existing brainctl sign-in still
   * resolves. Writes always land on {@link filePath}, so the next `set` migrates
   * the config across without the user re-authenticating.
   */
  async function read(): Promise<RegistryConfig> {
    const current = await readFrom(filePath);
    if (current) return current;
    if (legacyPath) return (await readFrom(legacyPath)) ?? {};
    return {};
  }

  async function write(config: RegistryConfig): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  return {
    path: () => filePath,
    async get(key) {
      return (await read())[key];
    },
    async set(key, value) {
      const config = await read();
      await write({ ...config, [key]: normalizeConfigValue(key, value) });
    },
    async unset(key) {
      const config = await read();
      delete config[key];
      await write(config);
    },
  };
}

export async function resolveRegistryApiTarget(
  options: RegistryConfigOptions & { configService?: RegistryConfigService } = {},
): Promise<RegistryApiTarget> {
  const env = options.env ?? process.env;
  const envValue =
    readBrandedEnv(env, "API_BASE_URL") ?? readBrandedEnv(env, "API_URL");
  if (envValue) return toApiTarget(normalizeBaseUrl(envValue), "env");

  const configService = options.configService ?? createRegistryConfigService(options);
  const configured = await configService.get("apiBaseUrl");
  if (configured) return toApiTarget(normalizeBaseUrl(configured), "config");

  return toApiTarget(DEFAULT_REGISTRY_API_BASE_URL, "default");
}

export async function resolveRegistryApiBaseUrl(
  options: RegistryConfigOptions & {
    apiBaseUrl?: string;
    configService?: RegistryConfigService;
  } = {},
): Promise<string> {
  if (options.apiBaseUrl) return normalizeBaseUrl(options.apiBaseUrl);
  return (await resolveRegistryApiTarget(options)).apiBaseUrl;
}

export type RegistryTokenSource = "env" | "config";

export async function resolveRegistryApiToken(
  options: RegistryConfigOptions & { configService?: RegistryConfigService } = {},
): Promise<{ token: string; source: RegistryTokenSource } | null> {
  const env = options.env ?? process.env;
  const envToken = readBrandedEnv(env, "API_TOKEN");
  if (envToken?.trim()) {
    return { token: envToken.trim(), source: "env" };
  }
  const configService = options.configService ?? createRegistryConfigService(options);
  const stored = await configService.get("apiToken");
  if (stored?.trim()) return { token: stored.trim(), source: "config" };
  return null;
}

/** Registry web UI base — where the browser sign-in flow lives. */
export async function resolveRegistryFrontendUrl(
  options: RegistryConfigOptions & {
    apiBaseUrl?: string;
    configService?: RegistryConfigService;
  } = {},
): Promise<string> {
  const env = options.env ?? process.env;
  const envFrontendUrl = readBrandedEnv(env, "FRONTEND_URL");
  if (envFrontendUrl?.trim()) {
    return normalizeBaseUrl(envFrontendUrl);
  }
  const configService = options.configService ?? createRegistryConfigService(options);
  const stored = await configService.get("apiFrontendUrl");
  if (stored) return normalizeBaseUrl(stored);
  if (options.apiBaseUrl) {
    try {
      const known = KNOWN_REGISTRY_FRONTENDS.get(normalizeBaseUrl(options.apiBaseUrl));
      if (known) return known;
      const url = new URL(options.apiBaseUrl);
      if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
        return `${url.protocol}//${url.hostname}:5173`;
      }
      if (url.hostname.startsWith("api.")) {
        return `${url.protocol}//app.${url.hostname.slice("api.".length)}`;
      }
    } catch {
      // fall through to default
    }
  }
  return DEFAULT_REGISTRY_FRONTEND_URL;
}

function normalizeConfig(value: Partial<RegistryConfig> | null): RegistryConfig {
  if (!value || typeof value !== "object") return {};
  const config: RegistryConfig = {};
  if (typeof value.apiBaseUrl === "string" && value.apiBaseUrl.trim()) {
    config.apiBaseUrl = normalizeBaseUrl(value.apiBaseUrl);
  }
  if (typeof value.apiFrontendUrl === "string" && value.apiFrontendUrl.trim()) {
    config.apiFrontendUrl = normalizeBaseUrl(value.apiFrontendUrl);
  }
  if (typeof value.apiToken === "string" && value.apiToken.trim()) {
    config.apiToken = value.apiToken.trim();
  }
  if (typeof value.apiRefreshToken === "string" && value.apiRefreshToken.trim()) {
    config.apiRefreshToken = value.apiRefreshToken.trim();
  }
  return config;
}

function normalizeConfigValue(key: RegistryConfigKey, value: string): string {
  if (key === "apiBaseUrl" || key === "apiFrontendUrl") return normalizeBaseUrl(value);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${key} cannot be empty.`);
  return trimmed;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("Registry URL cannot be empty.");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid registry URL "${value}". Use an http:// or https:// URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid registry URL "${value}". Use an http:// or https:// URL.`);
  }
  return trimmed;
}

function toApiTarget(apiBaseUrl: string, source: RegistryApiTargetSource): RegistryApiTarget {
  let mode: RegistryApiTargetMode = "custom";
  if (KNOWN_REGISTRY_FRONTENDS.has(apiBaseUrl)) {
    mode = "prod";
  } else {
    const { hostname } = new URL(apiBaseUrl);
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
      mode = "local";
    }
  }
  return { apiBaseUrl, source, mode };
}
