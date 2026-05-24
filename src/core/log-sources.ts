import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { LogEntry, LogQuery, LogSourceDefinition, LogStream } from "./types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_LINES = 500;
const MAX_LINES = 5000;
const MAX_BUFFER = 8 * 1024 * 1024; // 8 MB ceiling on a single read
const READ_TIMEOUT_MS = 15_000;

/** Heuristic: lines that look like errors render red and survive the "errors only" filter. */
const ERROR_PATTERN = /\b(error|fatal|exception|panic|traceback|fail(?:ed|ure)?)\b/i;
const WARN_PATTERN = /\b(warn|warning|deprecated)\b/i;

export class LogSourceError extends Error {}

/**
 * Reads a slice of a log source on demand. Never spawns a long-lived process —
 * each call is a one-shot read, so it works for files written out-of-band
 * (UAT/PROD) rather than streamed through a managed service.
 *
 * When the source has a `driver`, the query (time range, text, level) is pushed
 * down to the host; otherwise it tails and filters client-side.
 */
export async function readLogSource(
  source: LogSourceDefinition,
  query: LogQuery = {},
): Promise<LogEntry[]> {
  const count = clampLines(query.lines ?? DEFAULT_LINES);

  if (source.driver === "journald") {
    if (!source.unit) throw new LogSourceError("journald log source is missing a unit.");
    const argv = buildJournaldArgs(source.unit, query, count);
    const { stdout } = await runInvocation(argv, source.host);
    // journald filtered server-side already; just parse structured output.
    let entries = parseJournaldJson(source.name, stdout);
    if (query.before) {
      // `--reverse` returned newest-first and includes the boundary cursor;
      // restore chronological order and drop the (inclusive) boundary entry.
      entries = entries.reverse().filter((entry) => entry.cursor !== query.before);
    }
    return entries;
  }

  if (source.driver === "docker") {
    if (!source.container) throw new LogSourceError("docker log source is missing a container.");
    const argv = buildDockerArgs(source.container, query, count);
    const { stdout, stderr } = await runInvocation(argv, source.host);
    // docker logs has no native text/level filter, so apply those client-side.
    const entries = [
      ...toEntries(source.name, stdout, "stdout"),
      ...toEntries(source.name, stderr, "stderr"),
    ];
    return applyClientFilters(entries, query).slice(-count);
  }

  if (source.kind === "file") {
    if (!source.path) throw new LogSourceError("File log source is missing a path.");
    return applyClientFilters(await tailLocalFile(source.name, source.path, count), query);
  }

  if (source.kind === "ssh") {
    if (!source.host || !source.path) {
      throw new LogSourceError("SSH log source is missing host or path.");
    }
    const { stdout } = await execFileAsync(
      "ssh",
      [source.host, "tail", "-n", String(count), source.path],
      { maxBuffer: MAX_BUFFER, timeout: READ_TIMEOUT_MS },
    );
    return applyClientFilters(toEntries(source.name, stdout, "stdout"), query);
  }

  // command
  if (!source.command) throw new LogSourceError("Command log source is missing a command.");
  const { stdout, stderr } = await execFileAsync("sh", ["-c", source.command], {
    cwd: source.cwd,
    maxBuffer: MAX_BUFFER,
    timeout: READ_TIMEOUT_MS,
  });
  const entries = [
    ...toEntries(source.name, stdout, "stdout"),
    ...toEntries(source.name, stderr, "stderr"),
  ];
  return applyClientFilters(entries, query).slice(-count);
}

/**
 * Builds the journalctl argv for a unit + query. JSON output carries real
 * timestamps, priority, and cursors so we don't have to guess severity.
 */
export function buildJournaldArgs(unit: string, query: LogQuery, count: number): string[] {
  const args = ["journalctl", "-u", unit, "--no-pager", "-o", "json"];
  if (query.since) args.push("--since", query.since);
  if (query.until) args.push("--until", query.until);
  if (query.grep) args.push("--grep", query.grep);
  if (query.level === "error") args.push("-p", "err");
  else if (query.level === "warn") args.push("-p", "warning");
  if (query.before) {
    // Page older: start at the cursor and walk backwards `count` lines.
    args.push("--cursor", query.before, "--reverse", "-n", String(count));
  } else if (query.cursor) {
    // Page newer: everything after the cursor.
    args.push("--after-cursor", query.cursor, "-n", String(count));
  } else {
    args.push("-n", String(count));
  }
  return args;
}

/** Builds the `docker logs` argv for a container + query (time window only). */
export function buildDockerArgs(container: string, query: LogQuery, count: number): string[] {
  const args = ["docker", "logs", "--tail", String(count), "--timestamps"];
  if (query.since) args.push("--since", query.since);
  if (query.until) args.push("--until", query.until);
  args.push(container);
  return args;
}

/**
 * Runs an argv locally, or over ssh when `host` is set. For ssh the argv is
 * escaped and joined into a single remote command so values with spaces
 * (e.g. --since "1 hour ago") survive the remote shell.
 */
function runInvocation(argv: string[], host?: string) {
  const [file, args] = host
    ? ["ssh", [host, argv.map(shellEscape).join(" ")]]
    : [argv[0], argv.slice(1)];
  return execFileAsync(file, args, { maxBuffer: MAX_BUFFER, timeout: READ_TIMEOUT_MS });
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Parses journalctl `-o json` lines into entries with real timestamps + levels. */
function parseJournaldJson(service: string, stdout: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // tolerate the occasional non-JSON line
    }
    const text = decodeJournaldMessage(record.MESSAGE);
    const priority = Number(record.PRIORITY);
    // syslog priority: 0-3 = err/crit/alert/emerg → render as error (red).
    const stream: LogStream = Number.isFinite(priority) && priority <= 3 ? "stderr" : "stdout";
    const micros = Number(record.__REALTIME_TIMESTAMP);
    const timestamp = Number.isFinite(micros) ? new Date(micros / 1000).toISOString() : "";
    const cursor = typeof record.__CURSOR === "string" ? record.__CURSOR : undefined;
    entries.push({ service, stream, text, timestamp, cursor });
  }
  return entries;
}

/** journald MESSAGE is usually a string, but a byte array for non-UTF8 payloads. */
function decodeJournaldMessage(message: unknown): string {
  if (typeof message === "string") return message;
  if (Array.isArray(message)) {
    return String.fromCharCode(...message.filter((b): b is number => typeof b === "number"));
  }
  return message == null ? "" : String(message);
}

/** Applies `grep`/`level` to already-fetched entries (for non-journald sources). */
export function applyClientFilters(entries: LogEntry[], query: LogQuery): LogEntry[] {
  let result = entries;
  if (query.grep) {
    const matcher = compileGrep(query.grep);
    result = result.filter((entry) => matcher.test(entry.text));
  }
  if (query.level === "error") {
    result = result.filter((entry) => entry.stream === "stderr" || ERROR_PATTERN.test(entry.text));
  } else if (query.level === "warn") {
    result = result.filter(
      (entry) =>
        entry.stream === "stderr" || ERROR_PATTERN.test(entry.text) || WARN_PATTERN.test(entry.text),
    );
  }
  return result;
}

/** Treats the term as a regex, falling back to a literal match if it's invalid. */
function compileGrep(term: string): RegExp {
  try {
    return new RegExp(term, "i");
  } catch {
    return new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
}

async function tailLocalFile(name: string, path: string, count: number): Promise<LogEntry[]> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new LogSourceError(`File not found: ${path}`);
    if (code === "EACCES") throw new LogSourceError(`Permission denied: ${path}`);
    throw error;
  }
  return toEntries(name, contents, "stdout").slice(-count);
}

function toEntries(
  service: string,
  output: string,
  defaultStream: "stdout" | "stderr",
): LogEntry[] {
  const text = output.replace(/\n$/, "");
  if (!text) return [];
  return text.split("\n").map((line) => ({
    service,
    // File/ssh tails arrive as one stream; flag error-looking lines so they
    // still render red and survive the "errors only" filter.
    stream: defaultStream === "stdout" && ERROR_PATTERN.test(line) ? "stderr" : defaultStream,
    text: line,
    timestamp: "",
  }));
}

function clampLines(lines: number): number {
  if (!Number.isFinite(lines) || lines <= 0) return DEFAULT_LINES;
  return Math.min(Math.floor(lines), MAX_LINES);
}
