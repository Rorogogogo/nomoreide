/**
 * Credential redaction (export) and resolution (import) for portable
 * profiles, ported from brainctl's credential services. Exported archives
 * must never contain raw secrets: secret-looking env/header values become
 * `${credentials.<key>}` placeholders plus a spec describing what the
 * importer has to supply.
 */
import type { CredentialSpec, ProfileMcp } from "./types.js";

export interface RedactionResult {
  redacted: ProfileMcp;
  credentials: CredentialSpec[];
  /** Original secret values, keyed by normalized credential key (kept out of archives). */
  rawValues: Record<string, string>;
}

export function redactMcpCredentials(config: ProfileMcp): RedactionResult {
  const specs = new Map<string, { key: string; descriptions: Set<string> }>();
  const rawValues: Record<string, string> = {};
  const env = redactStringMap(config.env, "env", specs, rawValues);

  const redacted: ProfileMcp =
    config.kind === "remote"
      ? {
          ...config,
          ...(env ? { env } : {}),
          ...((() => {
            const headers = redactStringMap(config.headers, "header", specs, rawValues);
            return headers ? { headers } : {};
          })()),
        }
      : { ...config, ...(env ? { env } : {}) };

  return {
    redacted,
    credentials: Array.from(specs.values())
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((entry) => ({
        key: entry.key,
        required: true,
        description: `${Array.from(entry.descriptions).sort().join("; ")} required for MCP access`,
      })),
    rawValues,
  };
}

function redactStringMap(
  values: Record<string, string> | undefined,
  source: "env" | "header",
  specs: Map<string, { key: string; descriptions: Set<string> }>,
  rawValues: Record<string, string>,
): Record<string, string> | undefined {
  if (!values) return undefined;

  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!shouldRedact(key)) {
      redacted[key] = value;
      continue;
    }

    const credentialKey = tokenizeCredentialKey(key).join("_");
    const description = source === "env" ? `Environment variable ${key}` : `Header ${key}`;
    const existing = specs.get(credentialKey);
    if (existing) existing.descriptions.add(description);
    else specs.set(credentialKey, { key: credentialKey, descriptions: new Set([description]) });

    if (isCredentialPlaceholder(value)) {
      redacted[key] = value; // already a placeholder — keep as-is
    } else {
      rawValues[credentialKey] = value;
      redacted[key] = `\${credentials.${credentialKey}}`;
    }
  }

  return redacted;
}

function shouldRedact(key: string): boolean {
  const tokens = tokenizeCredentialKey(key);
  if (tokens.length === 0) return false;
  const last = tokens[tokens.length - 1];
  return (
    last === "authorization" ||
    last === "password" ||
    last === "secret" ||
    last === "token" ||
    (last === "key" && (tokens.includes("api") || tokens.includes("auth")))
  );
}

function tokenizeCredentialKey(key: string): string[] {
  return key
    .trim()
    .replace(/([A-Z]+)([A-Z][a-z0-9])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
}

function isCredentialPlaceholder(value: string): boolean {
  return (
    /^\$\{credentials\.[^}]+\}$/.test(value) ||
    /^(Bearer|Token)\s+\$\{credentials\.[^}]+\}$/i.test(value)
  );
}

export interface ResolutionResult {
  resolved: ProfileMcp;
  missing: CredentialSpec[];
}

export function resolveMcpCredentials(
  config: ProfileMcp,
  options: {
    credentials?: Record<string, string>;
    credentialSpecs?: CredentialSpec[];
    environment?: Record<string, string | undefined>;
  } = {},
): ResolutionResult {
  const specs = new Map((options.credentialSpecs ?? []).map((spec) => [spec.key, spec]));
  const missing = new Map<string, CredentialSpec>();
  const env = resolveStringMap(config.env, specs, missing, options);

  const resolved: ProfileMcp =
    config.kind === "remote"
      ? {
          ...config,
          ...(env ? { env } : {}),
          ...((() => {
            const headers = resolveStringMap(config.headers, specs, missing, options);
            return headers ? { headers } : {};
          })()),
        }
      : { ...config, ...(env ? { env } : {}) };

  return { resolved, missing: Array.from(missing.values()) };
}

function resolveStringMap(
  values: Record<string, string> | undefined,
  specs: Map<string, CredentialSpec>,
  missing: Map<string, CredentialSpec>,
  options: {
    credentials?: Record<string, string>;
    environment?: Record<string, string | undefined>;
  },
): Record<string, string> | undefined {
  if (!values) return undefined;

  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const placeholder = parseCredentialPlaceholder(value);
    if (!placeholder) {
      resolved[key] = value;
      continue;
    }

    const supplied =
      options.credentials?.[placeholder.key] ?? options.environment?.[placeholder.key];
    if (typeof supplied === "string" && supplied.length > 0) {
      resolved[key] = placeholder.prefix ? `${placeholder.prefix} ${supplied}` : supplied;
      continue;
    }

    const spec = specs.get(placeholder.key) ?? {
      key: placeholder.key,
      required: true,
      description: `Credential ${placeholder.key} is required`,
    };
    if (spec.required) missing.set(spec.key, spec);
    resolved[key] = value; // keep the placeholder; the user can fill it later
  }

  return resolved;
}

function parseCredentialPlaceholder(
  value: string,
): { key: string; prefix?: "Bearer" | "Token" } | null {
  const bare = value.match(/^\$\{credentials\.([^}]+)\}$/);
  if (bare) return { key: bare[1] };

  const prefixed = value.match(/^(Bearer|Token)\s+\$\{credentials\.([^}]+)\}$/i);
  if (prefixed) {
    return {
      key: prefixed[2],
      prefix: prefixed[1].toLowerCase() === "bearer" ? "Bearer" : "Token",
    };
  }
  return null;
}

const PLACEHOLDER_PATTERN = /\$\{\s*credentials\.([^}\s]+)\s*\}/g;

/** Every `${credentials.*}` key still present anywhere in the given MCPs. */
export function findUnresolvedCredentialKeys(mcps: Record<string, ProfileMcp>): string[] {
  const keys = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      for (const match of value.matchAll(PLACEHOLDER_PATTERN)) keys.add(match[1]);
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(visit);
    }
  };
  visit(mcps);
  return Array.from(keys).sort();
}
