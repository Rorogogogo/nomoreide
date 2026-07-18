/**
 * Profile registry configuration (ROR-63). The hosted registry is the
 * brainctl platform (kept as-is per the ROR-63 decision), so credentials and
 * target URLs live in brainctl's config file at `~/.brainctl/config.json` and
 * honor the `BRAINCTL_*` environment variables — existing brainctl sign-ins
 * keep working unchanged.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const DEFAULT_REGISTRY_API_BASE_URL = "https://api.brainctl.net";
export const DEFAULT_REGISTRY_FRONTEND_URL = "https://www.brainctl.net";

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

export function registryConfigPath(options: RegistryConfigOptions = {}): string {
  const env = options.env ?? process.env;
  return (
    options.configPath ??
    env.BRAINCTL_CONFIG_PATH ??
    path.join(env.BRAINCTL_HOME ?? homedir(), ".brainctl", "config.json")
  );
}

export function createRegistryConfigService(
  options: RegistryConfigOptions = {},
): RegistryConfigService {
  const filePath = registryConfigPath(options);

  async function read(): Promise<RegistryConfig> {
    let source: string;
    try {
      source = await readFile(filePath, "utf8");
    } catch {
      return {};
    }
    try {
      return normalizeConfig(JSON.parse(source) as Partial<RegistryConfig> | null);
    } catch (error) {
      throw new Error(
        `Invalid registry config at ${filePath}: ${(error as Error).message}`,
      );
    }
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
  const envValue = env.BRAINCTL_API_BASE_URL ?? env.BRAINCTL_API_URL;
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
  if (env.BRAINCTL_API_TOKEN?.trim()) {
    return { token: env.BRAINCTL_API_TOKEN.trim(), source: "env" };
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
  if (env.BRAINCTL_FRONTEND_URL?.trim()) {
    return normalizeBaseUrl(env.BRAINCTL_FRONTEND_URL);
  }
  const configService = options.configService ?? createRegistryConfigService(options);
  const stored = await configService.get("apiFrontendUrl");
  if (stored) return normalizeBaseUrl(stored);
  if (options.apiBaseUrl) {
    try {
      if (normalizeBaseUrl(options.apiBaseUrl) === DEFAULT_REGISTRY_API_BASE_URL) {
        return DEFAULT_REGISTRY_FRONTEND_URL;
      }
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
  if (apiBaseUrl === DEFAULT_REGISTRY_API_BASE_URL) {
    mode = "prod";
  } else {
    const { hostname } = new URL(apiBaseUrl);
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
      mode = "local";
    }
  }
  return { apiBaseUrl, source, mode };
}
