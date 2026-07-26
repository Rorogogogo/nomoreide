import {
  type PtyAdapter,
  TerminalSession,
  type TerminalSessionLike,
  type TerminalSize,
  type TerminalSnapshot,
} from "./terminal-session.js";
import type { InteractiveAgentProvider } from "./agent-terminal.js";

/** A session's snapshot plus the id the manager tracks it under. */
export interface TerminalSessionInfo extends TerminalSnapshot {
  id: string;
}

/** Per-session context overriding the manager's workspace defaults. */
export interface TerminalSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shell?: string;
  args?: string[];
  label?: string;
  kind?: "shell" | "service" | "agent";
  provider?: InteractiveAgentProvider;
}

/** The subset of the manager the web layer depends on (so tests can fake it). */
export interface TerminalSessionManagerLike {
  list(): TerminalSessionInfo[];
  create(
    size?: Partial<TerminalSize>,
    options?: TerminalSpawnOptions,
  ): TerminalSessionInfo;
  /** Get-or-create a session under a caller-chosen id (deduping reopens). */
  createWithId(id: string, options?: TerminalSpawnOptions): TerminalSessionInfo;
  get(id: string): TerminalSessionLike | undefined;
  ensure(id: string, size?: Partial<TerminalSize>): TerminalSessionLike;
  /** Register client activity (input/resize) so the idle timer resets. */
  touch(id: string): void;
  /** A client socket disconnected; reap the session after the grace window. */
  detach(id: string): void;
  rename(id: string, label: string): TerminalSessionInfo | undefined;
  close(id: string): boolean;
  disposeAll(): void;
}

export interface TerminalSessionManagerOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  shell?: string;
  /** Injectable per-session adapter factory; defaults to the real node-pty adapter. */
  adapterFactory?: () => PtyAdapter | undefined;
  /** Dispose a session after this many ms with no I/O. `0` disables. */
  idleTimeoutMs?: number;
  /** Dispose a session this many ms after its last client disconnects. `0` disables. */
  disconnectGraceMs?: number;
}

/** 30 minutes of silence (no input or output) reaps a session. */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** A reload reconnects within a moment; wait this long before reaping an orphan. */
const DEFAULT_DISCONNECT_GRACE_MS = 30 * 1000;

interface ManagedSession {
  session: TerminalSessionLike;
  /** Number of currently-attached client sockets. */
  connections: number;
  outputSub: { dispose(): void };
  idleTimer?: ReturnType<typeof setTimeout>;
  graceTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Owns the live terminal sessions keyed by id so the web UI can run several
 * tabs at once. The PTY lifecycle stays in {@link TerminalSession}; this layer
 * adds the keyed map, id generation, and — crucially for ssh/docker sessions
 * that hold real connections — automatic reaping: a session is disposed once it
 * goes idle for too long or once its last socket disconnects (after a short
 * grace window so a page reload can reattach).
 */
export class TerminalSessionManager implements TerminalSessionManagerLike {
  private readonly options: TerminalSessionManagerOptions;
  private readonly idleTimeoutMs: number;
  private readonly disconnectGraceMs: number;
  private readonly sessions = new Map<string, ManagedSession>();
  private counter = 0;

  constructor(options: TerminalSessionManagerOptions) {
    this.options = options;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.disconnectGraceMs =
      options.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS;
  }

  list(): TerminalSessionInfo[] {
    return [...this.sessions.entries()].map(([id, managed]) => ({
      id,
      ...managed.session.snapshot(),
    }));
  }

  create(
    size: Partial<TerminalSize> = {},
    options: TerminalSpawnOptions = {},
  ): TerminalSessionInfo {
    const id = `term_${++this.counter}`;
    const managed = this.spawn(id, size, options);
    this.sessions.set(id, managed);
    // Created but not yet connected: reap it if no socket attaches in time
    // (e.g. the POST landed but the client navigated away before connecting).
    this.scheduleGrace(id, managed);
    return { id, ...managed.session.snapshot() };
  }

  /**
   * Get-or-create a session under a caller-chosen id (e.g. `svc:<service>`), so
   * reopening a service terminal reattaches to the same shell instead of
   * spawning a duplicate. The spawn options are honored only on first creation.
   */
  createWithId(
    id: string,
    options: TerminalSpawnOptions = {},
  ): TerminalSessionInfo {
    const existing = this.sessions.get(id);
    if (existing) return { id, ...existing.session.snapshot() };
    const managed = this.spawn(id, {}, options);
    this.sessions.set(id, managed);
    this.scheduleGrace(id, managed);
    return { id, ...managed.session.snapshot() };
  }

  get(id: string): TerminalSessionLike | undefined {
    return this.sessions.get(id)?.session;
  }

  /**
   * Returns the session for `id`, creating one if unknown, and marks a client
   * as attached (this is the socket "connect" path).
   */
  ensure(id: string, size: Partial<TerminalSize> = {}): TerminalSessionLike {
    const existing = this.sessions.get(id);
    if (existing) {
      existing.session.start(size);
      this.markConnected(id, existing);
      return existing.session;
    }
    const managed = this.spawn(id, size, {});
    this.sessions.set(id, managed);
    this.markConnected(id, managed);
    return managed.session;
  }

  touch(id: string): void {
    const managed = this.sessions.get(id);
    if (managed) this.resetIdle(id, managed);
  }

  detach(id: string): void {
    const managed = this.sessions.get(id);
    if (!managed) return;
    // Keep the session alive on disconnect so a page reload or reopening the
    // tab reattaches to it. The idle timer is the only soft reaper; a full
    // process shutdown disposes everything (see `disposeAll`).
    managed.connections = Math.max(0, managed.connections - 1);
  }

  rename(id: string, label: string): TerminalSessionInfo | undefined {
    const managed = this.sessions.get(id);
    if (!managed) return undefined;
    return { id, ...managed.session.setLabel(label) };
  }

  close(id: string): boolean {
    const managed = this.sessions.get(id);
    if (!managed) return false;
    this.clearTimers(managed);
    managed.outputSub.dispose();
    managed.session.dispose();
    this.sessions.delete(id);
    return true;
  }

  disposeAll(): void {
    for (const managed of this.sessions.values()) {
      this.clearTimers(managed);
      managed.outputSub.dispose();
      managed.session.dispose();
    }
    this.sessions.clear();
  }

  private spawn(
    id: string,
    size: Partial<TerminalSize>,
    options: TerminalSpawnOptions,
  ): ManagedSession {
    const session = new TerminalSession({
      adapter: this.options.adapterFactory?.(),
      cwd: options.cwd ?? this.options.cwd,
      env: options.env ?? this.options.env,
      shell: options.shell ?? this.options.shell,
      args: options.args,
      kind: options.kind,
      label: options.label,
      provider: options.provider,
    });
    // PTY output counts as activity, so a live tail keeps the session alive.
    const outputSub = session.onOutput(() => this.touch(id));
    session.start(size);
    return { session, connections: 0, outputSub };
  }

  private markConnected(id: string, managed: ManagedSession): void {
    managed.connections += 1;
    if (managed.graceTimer) {
      clearTimeout(managed.graceTimer);
      managed.graceTimer = undefined;
    }
    this.resetIdle(id, managed);
  }

  private resetIdle(id: string, managed: ManagedSession): void {
    if (managed.idleTimer) clearTimeout(managed.idleTimer);
    if (this.idleTimeoutMs <= 0) return;
    managed.idleTimer = setTimeout(() => this.close(id), this.idleTimeoutMs);
    managed.idleTimer.unref?.();
  }

  private scheduleGrace(id: string, managed: ManagedSession): void {
    if (managed.graceTimer) clearTimeout(managed.graceTimer);
    if (this.disconnectGraceMs <= 0) return;
    managed.graceTimer = setTimeout(() => this.close(id), this.disconnectGraceMs);
    managed.graceTimer.unref?.();
  }

  private clearTimers(managed: ManagedSession): void {
    if (managed.idleTimer) clearTimeout(managed.idleTimer);
    if (managed.graceTimer) clearTimeout(managed.graceTimer);
    managed.idleTimer = undefined;
    managed.graceTimer = undefined;
  }
}
