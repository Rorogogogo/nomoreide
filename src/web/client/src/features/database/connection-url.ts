import type { DatabaseEngine } from "@/lib/api";

/** Discrete connection parts the user can fill in instead of pasting a URL. */
export interface ConnectionFields {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  /** Postgres only: append `?sslmode=require`. */
  ssl: boolean;
}

export const EMPTY_FIELDS: ConnectionFields = {
  host: "",
  port: "",
  user: "",
  password: "",
  database: "",
  ssl: false,
};

const DEFAULT_HOST = "localhost";

/**
 * Assemble discrete fields into a connection URL. Special characters in the
 * user/password (e.g. `@ : / ?`) are percent-encoded so the URI stays valid —
 * the exact footgun that trips people up when they hand-write the string.
 * SQLite has no URL form, so callers pass its file path straight through.
 *
 * Pass `includePassword: false` for the on-screen URL so the secret never
 * appears in the visible string; the real password is spliced back in only
 * when connecting/saving.
 */
export function buildConnectionUrl(
  engine: DatabaseEngine,
  fields: ConnectionFields,
  { includePassword = true }: { includePassword?: boolean } = {},
): string {
  const scheme = engine === "mysql" ? "mysql" : "postgres";
  const host = fields.host.trim() || DEFAULT_HOST;
  const port = fields.port.trim();
  const database = fields.database.trim().replace(/^\//, "");
  const user = fields.user.trim();
  const showPassword = includePassword && fields.password;

  const credentials = user
    ? `${encodeURIComponent(user)}${
        showPassword ? `:${encodeURIComponent(fields.password)}` : ""
      }@`
    : "";
  const portPart = port ? `:${port}` : "";
  const query =
    engine === "postgres" && fields.ssl ? "?sslmode=require" : "";

  return `${scheme}://${credentials}${host}${portPart}/${database}${query}`;
}

/**
 * Reverse of {@link buildConnectionUrl}: pull discrete fields back out of a URL
 * so editing the URL keeps the field inputs in sync. Returns `null` for input
 * that isn't yet a parseable URL (e.g. mid-typing), so callers leave the fields
 * untouched rather than clobbering them.
 */
export function parseConnectionUrl(raw: string): ConnectionFields | null {
  if (!raw.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  return {
    host: parsed.hostname,
    port: parsed.port,
    user: safeDecode(parsed.username),
    password: safeDecode(parsed.password),
    database: parsed.pathname.replace(/^\//, ""),
    ssl:
      parsed.searchParams.get("sslmode") === "require" ||
      parsed.searchParams.has("ssl"),
  };
}

/** Map a URL scheme to a known engine, so a pasted URL can switch the engine. */
export function engineFromUrl(raw: string): DatabaseEngine | null {
  const match = /^([a-z0-9+]+):\/\//i.exec(raw.trim());
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  if (scheme.startsWith("postgres")) return "postgres";
  if (scheme.startsWith("mysql")) return "mysql";
  if (scheme.startsWith("sqlite") || scheme === "file") return "sqlite";
  return null;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
