import type { AgentSession, AgentSessionStore } from "./agent-sessions.js";
import type { ReproBundleBuilder } from "./repro-bundle.js";
import { SnapshotManager, type Snapshot } from "./snapshot-manager.js";

/**
 * The Error → Fix loop. Closes the AI-native circle: turn an Error Inbox
 * incident into one agent task whose result is a reviewable, one-click-revertable
 * change-set.
 *
 * Today the separate features (Error Inbox, repro bundle, snapshot/restore,
 * change-set review) are chained by hand. {@link FixLoop.prepare} stitches them:
 * it builds the repro bundle, snapshots the working tree, and records an agent
 * session pinned to that snapshot — so whatever the in-dock agent then edits
 * surfaces in Agent → Changes with a "restore to before this session" button.
 *
 * Why the snapshot is taken here rather than auto-firing: the in-dock agent
 * runs the Claude/Codex CLI directly (it does not go through NoMoreIDE's MCP),
 * so the MCP recording wrapper's auto-snapshot never triggers for a dock run.
 * The fix endpoint must capture the pre-fix state itself.
 */

export interface FixPreparation {
  /** Recorded agent session id; the change-set/restore endpoints key off this. */
  sessionId: string;
  /** The fix prompt (repro bundle wrapped in a fix instruction) for the dock. */
  prompt: string;
  /** Repository the snapshot was taken in (where the agent will edit). */
  repoPath: string;
  /** Snapshot sha, or undefined when the repo isn't a git working tree. */
  snapshotSha?: string;
}

export interface FixLoopOptions {
  reproBundle: ReproBundleBuilder;
  agentSessions: AgentSessionStore;
  /** Resolve the repo the agent will edit (the selected git repository). */
  resolveRepoPath: () => Promise<string>;
  /** Injectable for tests. */
  snapshotManagerFor?: (repoPath: string) => Pick<SnapshotManager, "snapshot" | "prune">;
  now?: () => number;
}

const SNAPSHOT_KEEP = 50;

export class FixLoop {
  private readonly reproBundle: ReproBundleBuilder;
  private readonly agentSessions: AgentSessionStore;
  private readonly resolveRepoPath: () => Promise<string>;
  private readonly snapshotManagerFor: (
    repoPath: string,
  ) => Pick<SnapshotManager, "snapshot" | "prune">;
  private readonly now: () => number;

  constructor(options: FixLoopOptions) {
    this.reproBundle = options.reproBundle;
    this.agentSessions = options.agentSessions;
    this.resolveRepoPath = options.resolveRepoPath;
    this.snapshotManagerFor =
      options.snapshotManagerFor ?? ((repoPath) => new SnapshotManager(repoPath));
    this.now = options.now ?? Date.now;
  }

  /**
   * Prepare a fix for an incident: build the repro bundle, snapshot the working
   * tree, and record the session. Returns null when the incident is unknown.
   * Never throws on a missing/non-git repo — the session is recorded without a
   * snapshot so the run still proceeds (just no reviewable change-set).
   */
  async prepare(incidentId: number): Promise<FixPreparation | null> {
    const bundle = await this.reproBundle.build(incidentId);
    if (!bundle) return null;

    const repoPath = await this.resolveRepoPath();
    const startedAt = new Date(this.now()).toISOString();
    const session: AgentSession = {
      id: `s-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      repoPath,
      startedAt,
      lastToolAt: startedAt,
      toolCount: 0,
    };

    try {
      const manager = this.snapshotManagerFor(repoPath);
      const snapshot: Snapshot = await manager.snapshot(`fix incident ${incidentId}`);
      session.snapshotSha = snapshot.sha;
      session.snapshotRef = snapshot.ref;
      await manager.prune(SNAPSHOT_KEEP);
    } catch {
      // Not a git repo (or git unavailable) — record the session without a
      // snapshot. The fix still runs; there just isn't a change-set to review.
    }

    try {
      await this.agentSessions.save(session);
    } catch {
      // Persistence is best-effort; never block the fix on it.
    }

    return {
      sessionId: session.id,
      prompt: buildFixPrompt(bundle.markdown),
      repoPath,
      snapshotSha: session.snapshotSha,
    };
  }
}

/** Wrap the repro-bundle markdown in a concise fix instruction for the agent. */
export function buildFixPrompt(markdown: string): string {
  return [
    "A bug was detected in this workspace. Below is an automatically assembled repro bundle: the error, the affected file's diff, recent logs, the service's runtime state, and its environment with secrets masked.",
    "",
    "Investigate the root cause and apply the smallest change that resolves it. When you are done, briefly summarize what you changed and why. Your edits are snapshotted, so they can be reviewed and reverted as a single change-set.",
    "",
    "---",
    "",
    markdown,
  ].join("\n");
}
