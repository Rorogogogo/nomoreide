import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export type TranscriptProvider = "claude" | "codex";

export interface AgentTranscript {
  /** Session id accepted by `claude --resume <id>` / `codex resume <id>`. */
  id: string;
  provider: TranscriptProvider;
  /** Working directory the session ran in, read from the transcript body. */
  cwd: string;
  /** First real user prompt, used as the picker label. */
  title: string;
  startedAt: string;
  /** File mtime — when the session was last written to. */
  updatedAt: string;
}

/**
 * Both CLIs append newline-delimited JSON, so a session's identity, cwd and
 * opening prompt all land in the first handful of lines. Transcripts run to
 * megabytes, so every read stops as soon as those are in hand rather than
 * parsing the whole conversation.
 */
const MAX_HEAD_LINES = 500;
/** Upper bound on Codex rollout files opened per listing (they carry no path index). */
const MAX_CODEX_SCAN = 400;
/** Enough history per provider for the dock picker without letting one crowd out the other. */
const DEFAULT_TRANSCRIPT_LIMIT = 100;
const MAX_TITLE = 200;

/**
 * Claude encodes the cwd into a directory name lossily, and the encoding has
 * changed between releases — `~/.claude/projects` currently holds both
 * `...-Personal Project-brainctl` and `...-Personal-Project-brainctl`, and both
 * `...-extension-3.0` and `...-extension-3-0`. Collapsing every non-alphanumeric
 * run to a single `-` makes those variants compare equal, so one repo's history
 * is found across all the directories past versions wrote it to. The comparison
 * is deliberately lossy in the other direction too (sibling paths can collide),
 * which is why every candidate file is confirmed against the `cwd` recorded in
 * its own body before being returned.
 */
function pathKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}

/** Reads leading lines as JSON, stopping when `onEntry` reports it has enough. */
async function readHead(filePath: string, onEntry: (entry: Record<string, unknown>) => boolean): Promise<void> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let seen = 0;
  try {
    for await (const line of lines) {
      if (++seen > MAX_HEAD_LINES) break;
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // A truncated tail line must not discard the whole session.
      }
      if (entry && typeof entry === "object" && onEntry(entry as Record<string, unknown>)) break;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

/**
 * Injected context (environment blocks, slash-command expansions, system
 * reminders) is recorded as a user turn by both CLIs, so anything opening with
 * a tag is skipped in favour of the first prompt a human actually typed.
 */
function isTypedPrompt(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0
    && !trimmed.startsWith("<")
    && !trimmed.startsWith("# AGENTS.md instructions for ");
}

function toTitle(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, " ");
  return collapsed.length > MAX_TITLE ? `${collapsed.slice(0, MAX_TITLE - 1).trimEnd()}…` : collapsed;
}

/** Claude message content is either a plain string or an array of typed blocks. */
function claudeText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : ""))
    .join("");
}

function codexText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : ""))
    .join("");
}

async function readClaudeTranscript(filePath: string, fallbackId: string): Promise<AgentTranscript | null> {
  let id: string | undefined;
  let cwd: string | undefined;
  let title: string | undefined;
  let startedAt: string | undefined;

  await readHead(filePath, (entry) => {
    if (!id && typeof entry.sessionId === "string") id = entry.sessionId;
    if (!cwd && typeof entry.cwd === "string") cwd = entry.cwd;
    if (!startedAt && typeof entry.timestamp === "string") startedAt = entry.timestamp;
    if (!title && entry.type === "user" && entry.isSidechain !== true) {
      const message = entry.message;
      const text = claudeText(message && typeof message === "object" ? (message as { content?: unknown }).content : undefined);
      if (isTypedPrompt(text)) title = toTitle(text);
    }
    return Boolean(cwd && title);
  });

  if (!cwd) return null;
  const { mtime } = await stat(filePath);
  return {
    id: id ?? fallbackId,
    provider: "claude",
    cwd,
    title: title ?? "",
    startedAt: startedAt ?? mtime.toISOString(),
    updatedAt: mtime.toISOString(),
  };
}

/**
 * Codex records no per-project index, so a listing opens every recent rollout.
 * `expectedCwd` lets a session that belongs to another project stop at its
 * `session_meta` line instead of being read on in search of a prompt.
 */
async function readCodexTranscript(filePath: string, expectedCwd?: string): Promise<AgentTranscript | null> {
  let id: string | undefined;
  let cwd: string | undefined;
  let title: string | undefined;
  let startedAt: string | undefined;

  await readHead(filePath, (entry) => {
    const payload = entry.payload;
    if (!payload || typeof payload !== "object") return false;
    const body = payload as Record<string, unknown>;
    if (entry.type === "session_meta") {
      if (typeof body.session_id === "string") id = body.session_id;
      else if (typeof body.id === "string") id = body.id;
      if (typeof body.cwd === "string") cwd = body.cwd;
      if (typeof body.timestamp === "string") startedAt = body.timestamp;
      return Boolean(expectedCwd && cwd !== expectedCwd);
    }
    if (!title && body.type === "message" && body.role === "user") {
      const text = codexText(body.content);
      if (isTypedPrompt(text)) title = toTitle(text);
    }
    return Boolean(title);
  });

  if (!id || !cwd || (expectedCwd && cwd !== expectedCwd)) return null;
  const { mtime } = await stat(filePath);
  return {
    id,
    provider: "codex",
    cwd,
    title: title ?? "",
    startedAt: startedAt ?? mtime.toISOString(),
    updatedAt: mtime.toISOString(),
  };
}

async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return []; // A provider that was never installed simply contributes nothing.
  }
}

async function claudeTranscripts(homeDir: string, repoPath?: string): Promise<AgentTranscript[]> {
  const root = join(homeDir, ".claude", "projects");
  const key = repoPath ? pathKey(repoPath) : null;
  const dirs = (await listDir(root)).filter(
    (name) => !key || pathKey(name) === key,
  );
  const results: AgentTranscript[] = [];
  for (const dir of dirs) {
    const files = (await listDir(join(root, dir))).filter((name) => name.endsWith(".jsonl"));
    for (const file of files) {
      const transcript = await readClaudeTranscript(join(root, dir, file), file.replace(/\.jsonl$/, ""));
      if (transcript && (!repoPath || transcript.cwd === repoPath)) {
        results.push(transcript);
      }
    }
  }
  return results;
}

/** Codex buckets rollouts by `sessions/YYYY/MM/DD`, so newest dates are walked first. */
async function codexRolloutFiles(codexHome: string): Promise<string[]> {
  const root = join(codexHome, "sessions");
  const files: string[] = [];
  const descending = (values: string[]) => values.sort((a, b) => b.localeCompare(a));
  for (const year of descending(await listDir(root))) {
    for (const month of descending(await listDir(join(root, year)))) {
      for (const day of descending(await listDir(join(root, year, month)))) {
        const dir = join(root, year, month, day);
        for (const name of descending(await listDir(dir))) {
          if (name.startsWith("rollout-") && name.endsWith(".jsonl")) files.push(join(dir, name));
        }
        if (files.length >= MAX_CODEX_SCAN) return files;
      }
    }
  }
  return files;
}

async function codexTranscripts(codexHome: string, repoPath?: string): Promise<AgentTranscript[]> {
  const results: AgentTranscript[] = [];
  for (const filePath of await codexRolloutFiles(codexHome)) {
    const transcript = await readCodexTranscript(filePath, repoPath);
    if (transcript) results.push(transcript);
  }
  return results;
}

export interface ListAgentTranscriptsOptions {
  /** Omit to list recent sessions across every project. */
  repoPath?: string;
  limit?: number;
  /** Overridable for tests; defaults to the real home directory. */
  homeDir?: string;
  /** Overridable for tests and non-default Codex installations. */
  codexHome?: string;
}

/**
 * Prior Claude and Codex sessions for one repository, or every project when
 * `repoPath` is omitted, most recently written first. Metadata only — the
 * transcript bodies are never surfaced because resuming hands the conversation
 * back to the CLI that rendered it.
 */
export async function listAgentTranscripts(
  options: ListAgentTranscriptsOptions,
): Promise<AgentTranscript[]> {
  const { repoPath, limit = DEFAULT_TRANSCRIPT_LIMIT } = options;
  const homeDir = options.homeDir ?? homedir();
  const codexHome = options.codexHome
    ?? (options.homeDir ? join(homeDir, ".codex") : process.env.CODEX_HOME)
    ?? join(homeDir, ".codex");
  const [claude, codex] = await Promise.all([
    claudeTranscripts(homeDir, repoPath),
    codexTranscripts(codexHome, repoPath),
  ]);
  const newest = (transcripts: AgentTranscript[]) =>
    transcripts
      .filter((transcript) => transcript.title)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (options.limit !== undefined) {
    return newest([...claude, ...codex]).slice(0, limit);
  }
  return newest([
    ...newest(claude).slice(0, DEFAULT_TRANSCRIPT_LIMIT),
    ...newest(codex).slice(0, DEFAULT_TRANSCRIPT_LIMIT),
  ]);
}
