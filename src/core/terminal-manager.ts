import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import {
  ExternalTerminalLauncher,
  type ExternalTerminalAttachment,
  type ExternalTerminalCallbacks,
  type ExternalTerminalOpenOptions,
  externalTerminalTitle,
} from "./external-terminal.js";
import {
  type PtyAdapter,
  TerminalSession,
  type TerminalSessionLike,
  type TerminalSize,
  type TerminalSnapshot,
} from "./terminal-session.js";
import type { InteractiveAgentProvider } from "./agent-terminal.js";
import type { ExternalTerminalPreference } from "./app-settings.js";

/** A session's snapshot plus the id the manager tracks it under. */
export interface TerminalSessionInfo extends TerminalSnapshot {
  id: string;
  presentation: TerminalPresentation;
}

export type TerminalPresentation = "dock" | "terminalLaunching" | "terminal";

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
  /** Optional presentation controls used by daemon-capable implementations. */
  externalTerminalAvailable?(): boolean;
  openInSystemTerminal?(id: string): Promise<TerminalSessionInfo>;
  reclaimToDock?(id: string): TerminalSessionInfo | undefined;
  /** Insert a trusted, unsubmitted prompt into an existing agent session. */
  insertAgentPrompt?(id: string, prompt: string): TerminalSessionInfo;
  onSessionChanged?(listener: (session: TerminalSessionInfo) => void): { dispose(): void };
  /** Authoritative dock-owner gates for WebSocket input and resize. */
  writeFromDock?(id: string, data: string): boolean;
  resizeFromDock?(id: string, cols: number, rows: number): boolean;
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
  /** Injectable relay launcher for tests. `null` explicitly disables it. */
  externalTerminalLauncher?: ExternalTerminalLauncherLike | null;
  /** Resolves the latest user preference each time an external terminal opens. */
  externalTerminalPreference?: () =>
    | ExternalTerminalPreference
    | Promise<ExternalTerminalPreference>;
}

export interface ExternalTerminalLauncherLike {
  open(
    callbacks: ExternalTerminalCallbacks,
    options?: ExternalTerminalOpenOptions,
  ): Promise<ExternalTerminalAttachment>;
}

/** 30 minutes of silence (no input or output) reaps a session. */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** A reload reconnects within a moment; wait this long before reaping an orphan. */
const DEFAULT_DISCONNECT_GRACE_MS = 30 * 1000;
const TERMINAL_REPLAY_BYTES = 1024 * 1024;
export const MAX_AGENT_PROMPT_BYTES = 512 * 1024;
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

export function encodeAgentPromptPaste(prompt: string): string {
  if (prompt.length === 0) throw new Error("Agent prompt must not be empty.");
  if (Buffer.byteLength(prompt, "utf8") > MAX_AGENT_PROMPT_BYTES) {
    throw new Error("Agent prompt is too large.");
  }
  const normalized = prompt.replace(/\r\n/g, "\n");
  for (const character of normalized) {
    const code = character.charCodeAt(0);
    if (
      (code < 32 && character !== "\n" && character !== "\t") ||
      code === 127 ||
      (code >= 128 && code <= 159)
    ) {
      throw new Error("Agent prompt contains unsupported terminal control characters.");
    }
  }
  return `${BRACKETED_PASTE_START}${normalized.replace(/\n/g, "\r")}${BRACKETED_PASTE_END}`;
}

interface ManagedSession {
  session: TerminalSessionLike;
  /** Number of currently-attached client sockets. */
  connections: number;
  outputSub: { dispose(): void };
  stateSub: { dispose(): void };
  presentation: TerminalPresentation;
  generation: string;
  replay: BoundedReplay;
  external?: ExternalTerminalAttachment;
  pendingLease?: string;
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
  private readonly externalTerminalLauncher: ExternalTerminalLauncherLike | undefined;
  private readonly sessionListeners = new Set<(session: TerminalSessionInfo) => void>();
  private counter = 0;

  constructor(options: TerminalSessionManagerOptions) {
    this.options = options;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.disconnectGraceMs =
      options.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS;
    this.externalTerminalLauncher = options.externalTerminalLauncher === null
      ? undefined
      : options.externalTerminalLauncher ?? defaultExternalTerminalLauncher(
        options.externalTerminalPreference,
      );
  }

  list(): TerminalSessionInfo[] {
    return [...this.sessions.entries()].map(([id, managed]) =>
      this.info(id, managed));
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
    return this.info(id, managed);
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
    if (existing) return this.info(id, existing);
    const managed = this.spawn(id, {}, options);
    this.sessions.set(id, managed);
    this.scheduleGrace(id, managed);
    return this.info(id, managed);
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
      existing.session.start(existing.presentation === "dock" ? size : {});
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
    managed.session.setLabel(label);
    const snapshot = this.info(id, managed);
    this.emitSession(snapshot);
    return snapshot;
  }

  close(id: string): boolean {
    const managed = this.sessions.get(id);
    if (!managed) return false;
    this.clearTimers(managed);
    this.revokeExternal(managed);
    managed.outputSub.dispose();
    managed.stateSub.dispose();
    managed.session.dispose();
    this.sessions.delete(id);
    return true;
  }

  disposeAll(): void {
    for (const managed of this.sessions.values()) {
      this.clearTimers(managed);
      this.revokeExternal(managed);
      managed.outputSub.dispose();
      managed.stateSub.dispose();
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
    const generation = randomBytes(16).toString("hex");
    const managed: ManagedSession = {
      session,
      connections: 0,
      generation,
      presentation: "dock",
      replay: new BoundedReplay(TERMINAL_REPLAY_BYTES),
      outputSub: { dispose() {} },
      stateSub: { dispose() {} },
    };
    const outputSub = session.onOutput((data) => {
      this.touch(id);
      const chunk = Buffer.from(data);
      managed.replay.append(chunk);
      const external = managed.external;
      if (
        external &&
        managed.presentation === "terminal" &&
        !external.sendOutput(chunk)
      ) {
        this.resetExternal(id, managed, external.lease);
      }
    });
    const stateSub = session.onState((snapshot) => {
      if (snapshot.state !== "running") this.resetExternal(id, managed);
      this.emitSession(this.info(id, managed));
    });
    managed.outputSub = outputSub;
    managed.stateSub = stateSub;
    session.start(size);
    return managed;
  }

  externalTerminalAvailable(): boolean {
    return Boolean(this.externalTerminalLauncher);
  }

  onSessionChanged(listener: (session: TerminalSessionInfo) => void): { dispose(): void } {
    this.sessionListeners.add(listener);
    return { dispose: () => this.sessionListeners.delete(listener) };
  }

  writeFromDock(id: string, data: string): boolean {
    const managed = this.sessions.get(id);
    if (!managed || managed.presentation !== "dock") return false;
    managed.session.write(data);
    this.touch(id);
    return true;
  }

  insertAgentPrompt(id: string, prompt: string): TerminalSessionInfo {
    const managed = this.sessions.get(id);
    if (!managed) throw new Error(`Unknown terminal session: ${id}`);
    const snapshot = managed.session.snapshot();
    if (snapshot.kind !== "agent") {
      throw new Error("Only agent sessions can receive a prompt.");
    }
    if (snapshot.state !== "running") {
      throw new Error("Only a running agent session can receive a prompt.");
    }
    if (managed.presentation === "terminalLaunching") {
      throw new Error("An agent prompt cannot be inserted while Terminal is opening.");
    }
    managed.session.write(encodeAgentPromptPaste(prompt));
    this.touch(id);
    return this.info(id, managed);
  }

  resizeFromDock(id: string, cols: number, rows: number): boolean {
    const managed = this.sessions.get(id);
    if (!managed || managed.presentation !== "dock") return false;
    managed.session.resize(cols, rows);
    this.touch(id);
    return true;
  }

  async openInSystemTerminal(id: string): Promise<TerminalSessionInfo> {
    const launcher = this.externalTerminalLauncher;
    if (!launcher) {
      throw new Error("External Terminal is currently available on macOS only.");
    }
    const managed = this.sessions.get(id);
    if (!managed) throw new Error(`Unknown terminal session: ${id}`);
    const snapshot = managed.session.snapshot();
    if (snapshot.kind !== "agent") throw new Error("Only agent sessions can open in Terminal.");
    if (snapshot.state !== "running") throw new Error("Only a running agent session can open in Terminal.");
    if (managed.presentation !== "dock" || managed.external || managed.pendingLease) {
      throw new Error("This agent session is already opening or active in Terminal.");
    }

    const generation = managed.generation;
    const lease = randomBytes(16).toString("hex");
    const deferred = deferredExternalAttachment(lease);
    const inputDecoder = new StringDecoder("utf8");
    let receivedExternalSize = false;
    if (managed.graceTimer) {
      clearTimeout(managed.graceTimer);
      managed.graceTimer = undefined;
    }
    this.resetIdle(id, managed);
    managed.pendingLease = lease;
    managed.external = deferred.attachment;
    managed.presentation = "terminalLaunching";
    this.emitSession(this.info(id, managed));
    try {
      const external = await launcher.open({
        attached: () => {
          const current = this.sessions.get(id);
          if (!current || current !== managed || current.generation !== generation || current.pendingLease !== lease || current.session.snapshot().state !== "running") {
            return null;
          }
          current.presentation = "terminal";
          this.emitSession(this.info(id, current));
          return current.replay.snapshot();
        },
        input: (data) => {
          const current = this.sessions.get(id);
          if (current === managed && current.generation === generation && current.pendingLease === lease && current.presentation === "terminal") {
            const decoded = inputDecoder.write(data);
            if (decoded) current.session.write(decoded);
            this.touch(id);
          }
        },
        resize: (cols, rows) => {
          const current = this.sessions.get(id);
          if (current === managed && current.generation === generation && current.pendingLease === lease && current.presentation === "terminal") {
            if (!receivedExternalSize) {
              receivedExternalSize = true;
              current.session.resize(cols, rows > 1 ? rows - 1 : rows + 1);
            }
            current.session.resize(cols, rows);
            this.touch(id);
          }
        },
        detached: () => this.resetExternal(id, managed, lease),
      }, {
        lease,
        title: externalTerminalTitle(snapshot.provider, snapshot.label),
      });
      if (this.sessions.get(id) !== managed || managed.pendingLease !== lease) {
        external.revoke();
        throw new Error("Terminal attachment was superseded while opening.");
      }
      deferred.connect(external);
      return this.info(id, managed);
    } catch (error) {
      this.resetExternal(id, managed, lease);
      throw error;
    }
  }

  reclaimToDock(id: string): TerminalSessionInfo | undefined {
    const managed = this.sessions.get(id);
    if (!managed) return undefined;
    this.resetExternal(id, managed);
    return this.info(id, managed);
  }

  private resetExternal(id: string, managed: ManagedSession, expectedLease?: string): void {
    if (this.sessions.get(id) !== managed) return;
    const lease = managed.external?.lease ?? managed.pendingLease;
    if (expectedLease && lease !== expectedLease) return;
    const changed = managed.presentation !== "dock" || Boolean(managed.external || managed.pendingLease);
    const external = managed.external;
    managed.external = undefined;
    managed.pendingLease = undefined;
    managed.presentation = "dock";
    external?.revoke();
    if (changed) this.emitSession(this.info(id, managed));
  }

  private revokeExternal(managed: ManagedSession): void {
    const external = managed.external;
    managed.external = undefined;
    managed.pendingLease = undefined;
    managed.presentation = "dock";
    external?.revoke();
  }

  private info(id: string, managed: ManagedSession): TerminalSessionInfo {
    return { id, ...managed.session.snapshot(), presentation: managed.presentation };
  }

  private emitSession(snapshot: TerminalSessionInfo): void {
    for (const listener of this.sessionListeners) listener(snapshot);
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

class BoundedReplay {
  private readonly buffer: Buffer;
  private length = 0;
  private writeOffset = 0;

  constructor(private readonly capacity: number) {
    this.buffer = Buffer.allocUnsafe(capacity);
  }

  append(chunk: Buffer): void {
    if (chunk.length >= this.capacity) {
      chunk.copy(this.buffer, 0, chunk.length - this.capacity);
      this.length = this.capacity;
      this.writeOffset = 0;
      return;
    }
    const first = Math.min(chunk.length, this.capacity - this.writeOffset);
    chunk.copy(this.buffer, this.writeOffset, 0, first);
    if (first < chunk.length) chunk.copy(this.buffer, 0, first);
    this.writeOffset = (this.writeOffset + chunk.length) % this.capacity;
    this.length = Math.min(this.capacity, this.length + chunk.length);
  }

  snapshot(): Buffer {
    if (this.length === 0) return Buffer.alloc(0);
    const start = (this.writeOffset - this.length + this.capacity) % this.capacity;
    if (start + this.length <= this.capacity) {
      return Buffer.from(this.buffer.subarray(start, start + this.length));
    }
    const first = this.buffer.subarray(start);
    return Buffer.concat([first, this.buffer.subarray(0, this.length - first.length)]);
  }
}

function deferredExternalAttachment(lease: string): {
  attachment: ExternalTerminalAttachment;
  connect(attachment: ExternalTerminalAttachment): void;
} {
  let delegate: ExternalTerminalAttachment | undefined;
  let revoked = false;
  let queued: Buffer[] = [];
  let queuedBytes = 0;
  const attachment: ExternalTerminalAttachment = {
    lease,
    sendOutput(data) {
      if (revoked) return false;
      if (delegate) return delegate.sendOutput(data);
      queued.push(Buffer.from(data));
      queuedBytes += data.length;
      return queuedBytes <= TERMINAL_REPLAY_BYTES;
    },
    revoke() {
      revoked = true;
      queued = [];
      queuedBytes = 0;
      delegate?.revoke();
    },
  };
  return {
    attachment,
    connect(next) {
      delegate = next;
      if (revoked) {
        next.revoke();
        return;
      }
      const pending = queued;
      queued = [];
      queuedBytes = 0;
      for (const data of pending) {
        if (!next.sendOutput(data)) break;
      }
    },
  };
}

function defaultExternalTerminalLauncher(
  preference?: () =>
    | ExternalTerminalPreference
    | Promise<ExternalTerminalPreference>,
): ExternalTerminalLauncherLike | undefined {
  if (process.platform !== "darwin") return undefined;
  const installedEntry = fileURLToPath(new URL("../index.js", import.meta.url));
  const sourceFallback = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
  let entryPath: string | undefined;
  if (existsSync(installedEntry)) entryPath = installedEntry;
  else if (existsSync(sourceFallback)) entryPath = sourceFallback;
  if (!entryPath) return undefined;
  return new ExternalTerminalLauncher({
    entryPath,
    preference,
  });
}
