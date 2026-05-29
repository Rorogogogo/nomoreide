import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type AgentName = "claude-code" | "codex";

/**
 * Auth/connection state for a single MCP server, normalized across agents:
 * - `connected`  — reachable and authenticated (or no auth needed and healthy).
 * - `needs-auth` — an OAuth/login step is required before the server works.
 * - `no-auth`    — a local (stdio) server that has no auth concept.
 * - `failed`     — the server errored / wouldn't start on a fresh health check.
 * - `unknown`    — pending approval or an unparseable status line.
 *
 * Note: this reflects a *fresh* `mcp list` health check (a cold re-spawn), which
 * can differ from a long-lived `claude` session's live `/mcp` view.
 */
export type McpAuthState = "connected" | "needs-auth" | "no-auth" | "failed" | "unknown";

export interface McpAuthStatus {
  name: string;
  state: McpAuthState;
}

interface CacheEntry {
  at: number;
  statuses: McpAuthStatus[];
}

/** Health checks are slow (a few seconds); cache briefly so repeated tab views are cheap. */
const CACHE_TTL_MS = 15_000;
const cache = new Map<AgentName, CacheEntry>();

/**
 * Ask the agent's own CLI for the live auth/connection state of every MCP
 * server. We shell out to `claude mcp list` / `codex mcp list --json` because
 * the CLI is the authoritative source — it health-checks each server, covers
 * stdio and remote transports uniformly, and stays correct as tokens expire.
 * Returns `[]` if the CLI is missing or errors, so the UI degrades gracefully.
 */
export async function getMcpAuthStatuses(agent: AgentName): Promise<McpAuthStatus[]> {
  const cached = cache.get(agent);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.statuses;
  const statuses = agent === "codex" ? await codexStatuses() : await claudeStatuses();
  cache.set(agent, { at: Date.now(), statuses });
  return statuses;
}

async function claudeStatuses(): Promise<McpAuthStatus[]> {
  try {
    const { stdout } = await execFileAsync("claude", ["mcp", "list"], {
      timeout: 30_000,
      maxBuffer: 1 << 20,
    });
    return parseClaudeList(stdout);
  } catch (err) {
    // `claude mcp list` can exit non-zero while still printing a usable table.
    const stdout = (err as { stdout?: string }).stdout;
    return stdout ? parseClaudeList(stdout) : [];
  }
}

/** Each server is one line: `<name>: <url-or-command> - <status>`. Exported for tests. */
export function parseClaudeList(stdout: string): McpAuthStatus[] {
  const out: McpAuthStatus[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    const sep = trimmed.lastIndexOf(" - ");
    const colon = trimmed.indexOf(": ");
    if (sep < 0 || colon < 0 || colon > sep) continue;
    const name = trimmed.slice(0, colon).trim();
    const status = trimmed.slice(sep + 3).trim();
    if (name) out.push({ name, state: claudeState(status) });
  }
  return out;
}

function claudeState(status: string): McpAuthState {
  const s = status.toLowerCase();
  if (s.includes("needs authentication")) return "needs-auth";
  if (s.includes("connected")) return "connected";
  if (s.includes("failed") || s.includes("error")) return "failed";
  return "unknown";
}

interface CodexJsonEntry {
  name?: string;
  auth_status?: string;
}

async function codexStatuses(): Promise<McpAuthStatus[]> {
  try {
    const { stdout } = await execFileAsync("codex", ["mcp", "list", "--json"], {
      timeout: 30_000,
      maxBuffer: 1 << 20,
    });
    const parsed = JSON.parse(stdout) as CodexJsonEntry[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is CodexJsonEntry & { name: string } => typeof entry.name === "string")
      .map((entry) => ({ name: entry.name, state: codexState(entry.auth_status) }));
  } catch {
    return [];
  }
}

function codexState(auth?: string): McpAuthState {
  const s = (auth ?? "").toLowerCase();
  if (!s || s === "unsupported" || s === "not_required" || s === "none") return "no-auth";
  // Order matters: "not_logged_in" contains "logged_in", so test the negatives first.
  if (/not_logged_in|logged_out|needs|unauth|expired|required/.test(s)) return "needs-auth";
  if (/logged_in|authenticated|authorized|^ok$|connected/.test(s)) return "connected";
  return "unknown";
}
