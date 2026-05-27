import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export type TerminalState = "idle" | "running" | "exited" | "error";

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface TerminalExit {
  exitCode?: number;
  signal?: number | string;
}

export interface TerminalSnapshot extends TerminalSize {
  cwd: string;
  state: TerminalState;
  shell: string;
  /** Human label for the tab (e.g. a service name); absent for plain shells. */
  label?: string;
  exit?: TerminalExit;
  error?: string;
}

export interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (exit: TerminalExit) => void): { dispose(): void };
}

export interface PtyAdapter {
  spawn(
    file: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      cols: number;
      rows: number;
      name: string;
    },
  ): PtyProcess;
}

export interface TerminalSessionOptions {
  adapter?: PtyAdapter;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  shell?: string;
  /** Args for the spawned program. Empty → a plain interactive shell. */
  args?: string[];
  label?: string;
}

type Listener<T> = (value: T) => void;

export interface TerminalSessionLike {
  dispose(): void;
  onOutput(listener: Listener<string>): { dispose(): void };
  onState(listener: Listener<TerminalSnapshot>): { dispose(): void };
  resize(cols: number, rows: number): TerminalSnapshot;
  restart(size?: Partial<TerminalSize>): TerminalSnapshot;
  snapshot(): TerminalSnapshot;
  start(size?: Partial<TerminalSize>): TerminalSnapshot;
  stop(signal?: string): TerminalSnapshot;
  write(data: string): void;
}

export class TerminalSession implements TerminalSessionLike {
  private readonly adapter: PtyAdapter;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly shell: string;
  private readonly args: string[];
  private readonly label: string | undefined;
  private cols = 80;
  private rows = 24;
  private exit: TerminalExit | undefined;
  private error: string | undefined;
  private outputListeners = new Set<Listener<string>>();
  private stateListeners = new Set<Listener<TerminalSnapshot>>();
  private process: PtyProcess | undefined;
  private state: TerminalState = "idle";
  private disposables: Array<{ dispose(): void }> = [];

  constructor(options: TerminalSessionOptions) {
    this.adapter = options.adapter ?? new NodePtyAdapter();
    this.cwd = options.cwd;
    this.env = options.env ?? process.env;
    this.shell = options.shell ?? defaultShell();
    this.args = options.args ?? [];
    this.label = options.label;
  }

  snapshot(): TerminalSnapshot {
    return {
      cols: this.cols,
      cwd: this.cwd,
      error: this.error,
      exit: this.exit,
      label: this.label,
      rows: this.rows,
      shell: this.shell,
      state: this.state,
    };
  }

  onOutput(listener: Listener<string>): { dispose(): void } {
    this.outputListeners.add(listener);
    return {
      dispose: () => {
        this.outputListeners.delete(listener);
      },
    };
  }

  onState(listener: Listener<TerminalSnapshot>): { dispose(): void } {
    this.stateListeners.add(listener);
    return {
      dispose: () => {
        this.stateListeners.delete(listener);
      },
    };
  }

  start(size: Partial<TerminalSize> = {}): TerminalSnapshot {
    if (this.process && this.state === "running") {
      if (size.cols && size.rows) this.resize(size.cols, size.rows);
      return this.snapshot();
    }

    this.cols = normalizeDimension(size.cols, this.cols);
    this.rows = normalizeDimension(size.rows, this.rows);
    this.exit = undefined;
    this.error = undefined;

    try {
      const child = this.adapter.spawn(this.shell, this.args, {
        cols: this.cols,
        cwd: this.cwd,
        env: this.env,
        name: "xterm-256color",
        rows: this.rows,
      });
      this.process = child;
      this.state = "running";
      this.disposables = [
        child.onData((data) => this.emitOutput(data)),
        child.onExit((exit) => {
          this.exit = exit;
          this.process = undefined;
          this.state = "exited";
          this.disposeProcessListeners();
          this.emitState();
        }),
      ];
    } catch (caught) {
      this.process = undefined;
      this.error = caught instanceof Error ? caught.message : String(caught);
      this.state = "error";
    }

    this.emitState();
    return this.snapshot();
  }

  restart(size: Partial<TerminalSize> = {}): TerminalSnapshot {
    this.stop("SIGHUP");
    return this.start(size);
  }

  stop(signal = "SIGHUP"): TerminalSnapshot {
    const child = this.process;
    this.process = undefined;
    if (child) {
      child.kill(signal);
    }
    this.disposeProcessListeners();
    if (this.state === "running") {
      this.state = "exited";
      this.exit = { signal };
    }
    this.emitState();
    return this.snapshot();
  }

  write(data: string): void {
    if (!this.process || this.state !== "running") return;
    this.process.write(data);
  }

  resize(cols: number, rows: number): TerminalSnapshot {
    this.cols = normalizeDimension(cols, this.cols);
    this.rows = normalizeDimension(rows, this.rows);
    if (this.process && this.state === "running") {
      this.process.resize(this.cols, this.rows);
    }
    this.emitState();
    return this.snapshot();
  }

  dispose(): void {
    this.stop("SIGHUP");
    this.outputListeners.clear();
    this.stateListeners.clear();
  }

  private emitOutput(data: string): void {
    for (const listener of this.outputListeners) listener(data);
  }

  private emitState(): void {
    const snapshot = this.snapshot();
    for (const listener of this.stateListeners) listener(snapshot);
  }

  private disposeProcessListeners(): void {
    for (const item of this.disposables) item.dispose();
    this.disposables = [];
  }
}

class NodePtyAdapter implements PtyAdapter {
  spawn(
    file: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      cols: number;
      rows: number;
      name: string;
    },
  ): PtyProcess {
    const nodePty = require("node-pty") as typeof import("node-pty");
    return nodePty.spawn(file, args, options);
  }
}

function defaultShell(): string {
  if (process.env.SHELL) return process.env.SHELL;
  if (process.platform === "win32") return process.env.COMSPEC ?? "cmd.exe";
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/sh";
}

function normalizeDimension(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}
