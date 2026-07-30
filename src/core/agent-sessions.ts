import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isGitWorktree, type ConfigStore } from "./config-store.js";
import { SnapshotManager, type Snapshot } from "./snapshot-manager.js";

export interface AgentSession {
  id: string;
  /** Repository the session snapshot was taken in. */
  repoPath: string;
  /** Snapshot of the working tree before the session's first tool call. */
  snapshotSha?: string;
  snapshotRef?: string;
  startedAt: string;
  lastToolAt: string;
  toolCount: number;
}

const MAX_SESSIONS = 50;

/**
 * By default, sessions are persisted to `~/.nomoreide/agent-sessions.json`
 * (not kept only in memory) because the MCP server and the web UI may run in
 * different processes — the UI must be able to list change-sets it didn't
 * record.
 */
export class AgentSessionStore {
  constructor(private readonly filePath: string) {}

  async list(): Promise<AgentSession[]> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      return Array.isArray(parsed) ? (parsed as AgentSession[]) : [];
    } catch {
      return [];
    }
  }

  async get(id: string): Promise<AgentSession | undefined> {
    return (await this.list()).find((session) => session.id === id);
  }

  async save(session: AgentSession): Promise<void> {
    const sessions = (await this.list()).filter((existing) => existing.id !== session.id);
    sessions.unshift(session);
    sessions.splice(MAX_SESSIONS);
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(sessions, null, 2)}\n`, "utf8");
  }
}

export interface AgentSessionTracker {
  /**
   * Called before every recorded tool call. Starts a session (taking a
   * working-tree snapshot) when none is active or the previous one went
   * idle; otherwise bumps the active session. Never throws — a failed
   * snapshot (e.g. not a git repo) must not block the tool call.
   */
  beforeToolCall(): Promise<string>;
}

export interface AgentSessionTrackerOptions {
  store: AgentSessionStore;
  configStore: ConfigStore;
  cwd?: string;
  /** Gap after which the next tool call starts a new session. */
  idleMs?: number;
  /** Injectable for tests. */
  snapshotManagerFor?: (repoPath: string) => Pick<SnapshotManager, "snapshot" | "prune">;
  now?: () => number;
}

const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const SNAPSHOT_KEEP = 50;

export function createAgentSessionTracker(
  options: AgentSessionTrackerOptions,
): AgentSessionTracker {
  const cwd = options.cwd ?? process.cwd();
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const now = options.now ?? Date.now;
  const snapshotManagerFor =
    options.snapshotManagerFor ?? ((repoPath: string) => new SnapshotManager(repoPath));
  let active: AgentSession | null = null;
  let pending: Promise<string> | null = null;

  async function beginSession(): Promise<AgentSession> {
    const startedAt = new Date(now()).toISOString();
    const repoPath = await selectedRepoPath(options.configStore, cwd);
    const session: AgentSession = {
      id: `s-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      repoPath,
      startedAt,
      lastToolAt: startedAt,
      toolCount: 0,
    };
    try {
      const manager = snapshotManagerFor(repoPath);
      const snapshot: Snapshot = await manager.snapshot(`agent session ${session.id}`);
      session.snapshotSha = snapshot.sha;
      session.snapshotRef = snapshot.ref;
      await manager.prune(SNAPSHOT_KEEP);
    } catch {
      // Not a git repo (or git unavailable) — track the session without a snapshot.
    }
    return session;
  }

  return {
    async beforeToolCall(): Promise<string> {
      // Serialize: parallel tool calls at session start must share one snapshot.
      const previous = pending ?? Promise.resolve("");
      const next = previous
        .catch(() => "")
        .then(async () => {
          const timestamp = now();
          if (!active || timestamp - Date.parse(active.lastToolAt) > idleMs) {
            active = await beginSession();
          }
          active.lastToolAt = new Date(timestamp).toISOString();
          active.toolCount += 1;
          try {
            await options.store.save(active);
          } catch {
            // Persistence is best-effort; never block the tool call.
          }
          return active.id;
        });
      pending = next;
      return next;
    },
  };
}

async function selectedRepoPath(
  configStore: ConfigStore,
  fallbackCwd: string,
): Promise<string> {
  try {
    const config = await configStore.load();
    const repos = config.gitRepositories ?? [];
    const selected =
      repos.find((repo) => repo.name === config.selectedGitRepository) ?? repos[0];
    if (
      selected?.activeWorktreePath &&
      await isGitWorktree(selected.activeWorktreePath)
    ) {
      return selected.activeWorktreePath;
    }
    return selected?.path ?? fallbackCwd;
  } catch {
    return fallbackCwd;
  }
}
