import {
  type PtyAdapter,
  TerminalSession,
  type TerminalSessionLike,
  type TerminalSize,
  type TerminalSnapshot,
} from "./terminal-session.js";

/** A session's snapshot plus the id the manager tracks it under. */
export interface TerminalSessionInfo extends TerminalSnapshot {
  id: string;
}

/** The subset of the manager the web layer depends on (so tests can fake it). */
export interface TerminalSessionManagerLike {
  list(): TerminalSessionInfo[];
  create(size?: Partial<TerminalSize>): TerminalSessionInfo;
  get(id: string): TerminalSessionLike | undefined;
  ensure(id: string, size?: Partial<TerminalSize>): TerminalSessionLike;
  close(id: string): boolean;
  disposeAll(): void;
}

export interface TerminalSessionManagerOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  shell?: string;
  /** Injectable per-session adapter factory; defaults to the real node-pty adapter. */
  adapterFactory?: () => PtyAdapter | undefined;
}

/**
 * Owns the live terminal sessions keyed by id so the web UI can run several
 * tabs at once. The PTY lifecycle stays in {@link TerminalSession}; this layer
 * only adds the keyed map, id generation, and fan-out helpers.
 */
export class TerminalSessionManager implements TerminalSessionManagerLike {
  private readonly options: TerminalSessionManagerOptions;
  private readonly sessions = new Map<string, TerminalSessionLike>();
  private counter = 0;

  constructor(options: TerminalSessionManagerOptions) {
    this.options = options;
  }

  list(): TerminalSessionInfo[] {
    return [...this.sessions.entries()].map(([id, session]) => ({
      id,
      ...session.snapshot(),
    }));
  }

  create(size: Partial<TerminalSize> = {}): TerminalSessionInfo {
    const id = `term_${++this.counter}`;
    const session = this.spawn(size);
    this.sessions.set(id, session);
    return { id, ...session.snapshot() };
  }

  get(id: string): TerminalSessionLike | undefined {
    return this.sessions.get(id);
  }

  /** Returns the session for `id`, creating and starting one if it is unknown. */
  ensure(id: string, size: Partial<TerminalSize> = {}): TerminalSessionLike {
    const existing = this.sessions.get(id);
    if (existing) {
      existing.start(size);
      return existing;
    }
    const session = this.spawn(size);
    this.sessions.set(id, session);
    return session;
  }

  close(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.dispose();
    this.sessions.delete(id);
    return true;
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }

  private spawn(size: Partial<TerminalSize>): TerminalSessionLike {
    const session = new TerminalSession({
      adapter: this.options.adapterFactory?.(),
      cwd: this.options.cwd,
      env: this.options.env,
      shell: this.options.shell,
    });
    session.start(size);
    return session;
  }
}
