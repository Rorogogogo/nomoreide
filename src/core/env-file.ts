import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface EnvEntry {
  key: string;
  value: string;
}

export type EnvLine =
  | { kind: "kv"; key: string; value: string; quote: "" | "'" | '"' }
  | { kind: "raw"; text: string };

const KV_RE = /^([A-Za-z_][A-Za-z0-9_.]*)=(.*)$/;

export function envFilePath(serviceCwd: string): string {
  return join(serviceCwd, ".env");
}

export function parseEnvFile(content: string): EnvLine[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.map((line) => {
    const trimmed = line.trimStart();
    if (trimmed === "" || trimmed.startsWith("#")) {
      return { kind: "raw", text: line } as EnvLine;
    }
    const match = KV_RE.exec(line);
    if (!match) {
      return { kind: "raw", text: line } as EnvLine;
    }
    const key = match[1];
    const rawValue = match[2];
    const { value, quote } = unquote(rawValue);
    return { kind: "kv", key, value, quote };
  });
}

export function serializeEnvLines(lines: EnvLine[]): string {
  const body = lines
    .map((line) => {
      if (line.kind === "raw") return line.text;
      return `${line.key}=${quote(line.value, line.quote)}`;
    })
    .join("\n");
  return `${body}\n`;
}

export function mergeEntries(existing: EnvLine[], entries: EnvEntry[]): EnvLine[] {
  const keep = new Set(entries.map((entry) => entry.key));
  const byKey = new Map(entries.map((entry) => [entry.key, entry.value]));
  const seen = new Set<string>();
  const result: EnvLine[] = [];

  for (const line of existing) {
    if (line.kind === "raw") {
      result.push(line);
      continue;
    }
    if (!keep.has(line.key)) continue;
    seen.add(line.key);
    const value = byKey.get(line.key) ?? "";
    result.push({
      kind: "kv",
      key: line.key,
      value,
      quote: pickQuote(value, line.quote),
    });
  }

  for (const entry of entries) {
    if (seen.has(entry.key)) continue;
    result.push({
      kind: "kv",
      key: entry.key,
      value: entry.value,
      quote: pickQuote(entry.value, ""),
    });
  }

  return result;
}

export function entriesFromLines(lines: EnvLine[]): EnvEntry[] {
  return lines
    .filter((line): line is Extract<EnvLine, { kind: "kv" }> => line.kind === "kv")
    .map((line) => ({ key: line.key, value: line.value }));
}

export async function readEnvFile(path: string): Promise<{
  exists: boolean;
  lines: EnvLine[];
}> {
  try {
    const content = await readFile(path, "utf8");
    return { exists: true, lines: parseEnvFile(content) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, lines: [] };
    }
    throw error;
  }
}

export async function writeEnvFile(path: string, lines: EnvLine[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeEnvLines(lines));
}

function unquote(raw: string): { value: string; quote: "" | "'" | '"' } {
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw[raw.length - 1];
    if (first === '"' && last === '"') {
      return { value: raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n"), quote: '"' };
    }
    if (first === "'" && last === "'") {
      return { value: raw.slice(1, -1), quote: "'" };
    }
  }
  return { value: raw, quote: "" };
}

function quote(value: string, preferred: "" | "'" | '"'): string {
  const needsQuoting = /[\s#"']/.test(value) || value === "";
  if (!needsQuoting && preferred === "") return value;
  if (preferred === "'" && !value.includes("'")) return `'${value}'`;
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  return `"${escaped}"`;
}

function pickQuote(value: string, current: "" | "'" | '"'): "" | "'" | '"' {
  if (current !== "") return current;
  return /[\s#"']/.test(value) || value === "" ? '"' : "";
}

const SECRET_HINTS = ["secret", "token", "key", "password", "passwd", "auth", "credential"];

export function looksSecret(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET_HINTS.some((hint) => lower.includes(hint));
}
