import { describe, expect, test } from "vitest";
import {
  TerminalSession,
  type PtyAdapter,
  type PtyProcess,
  type TerminalExit,
} from "../src/core/terminal-session.js";

class FakePtyProcess implements PtyProcess {
  readonly writes: string[] = [];
  readonly sizes: Array<{ cols: number; rows: number }> = [];
  killed = false;
  signal?: string;
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(exit: TerminalExit) => void> = [];

  constructor(
    readonly file: string,
    readonly args: string[],
    readonly options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      cols: number;
      rows: number;
      name: string;
    },
  ) {}

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.sizes.push({ cols, rows });
  }

  kill(signal?: string): void {
    this.killed = true;
    this.signal = signal;
  }

  onData(callback: (data: string) => void): { dispose(): void } {
    this.dataListeners.push(callback);
    return {
      dispose: () => {
        this.dataListeners = this.dataListeners.filter((item) => item !== callback);
      },
    };
  }

  onExit(callback: (exit: TerminalExit) => void): { dispose(): void } {
    this.exitListeners.push(callback);
    return {
      dispose: () => {
        this.exitListeners = this.exitListeners.filter((item) => item !== callback);
      },
    };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(exit: TerminalExit): void {
    for (const listener of this.exitListeners) listener(exit);
  }
}

class FakePtyAdapter implements PtyAdapter {
  readonly spawned: FakePtyProcess[] = [];

  get active(): FakePtyProcess | undefined {
    return this.spawned.at(-1);
  }

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
    const process = new FakePtyProcess(file, args, options);
    this.spawned.push(process);
    return process;
  }
}

describe("TerminalSession", () => {
  test("starts a shell in the configured cwd and emits output", () => {
    const adapter = new FakePtyAdapter();
    const session = new TerminalSession({
      adapter,
      cwd: "/repo",
      shell: "/bin/zsh",
    });
    const output: string[] = [];
    session.onOutput((chunk) => output.push(chunk));

    session.start({ cols: 100, rows: 30 });
    adapter.active?.emitData("ready");

    expect(adapter.active?.file).toBe("/bin/zsh");
    expect(adapter.active?.args).toEqual([]);
    expect(adapter.active?.options.cwd).toBe("/repo");
    expect(adapter.active?.options.cols).toBe(100);
    expect(adapter.active?.options.rows).toBe(30);
    expect(adapter.active?.options.name).toBe("xterm-256color");
    expect(output).toEqual(["ready"]);
    expect(session.snapshot()).toMatchObject({
      cwd: "/repo",
      state: "running",
    });
    expect(session.snapshot().kind).toBeUndefined();
    expect(session.snapshot().provider).toBeUndefined();
  });

  test.each(["agent", "shell", "service"] as const)(
    "%s terminals normalize inherited interactive environment flags",
    (kind) => {
      const adapter = new FakePtyAdapter();
      const session = new TerminalSession({
        adapter,
        cwd: "/repo",
        env: {
          __CFBundleIdentifier: "com.mitchellh.ghostty",
          CLAUDECODE: "1",
          COLORFGBG: "15;0",
          COLORTERM: "truecolor",
          GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app/Contents/Resources",
          NO_COLOR: "1",
          PATH: "/usr/bin",
          TERM_PROGRAM: "ghostty",
          TERM_PROGRAM_VERSION: "1.3.1",
          TERM_SESSION_ID: "session-parent",
        },
        kind,
      });

      session.start();

      expect(adapter.active?.options.env).toMatchObject({
        PATH: "/usr/bin",
        TERM: "xterm-256color",
      });
      expect(adapter.active?.options.env.CLAUDECODE).toBeUndefined();
      expect(adapter.active?.options.env.__CFBundleIdentifier).toBeUndefined();
      expect(adapter.active?.options.env.COLORFGBG).toBeUndefined();
      expect(adapter.active?.options.env.COLORTERM).toBeUndefined();
      expect(adapter.active?.options.env.GHOSTTY_RESOURCES_DIR).toBeUndefined();
      expect(adapter.active?.options.env.NO_COLOR).toBeUndefined();
      expect(adapter.active?.options.env.TERM_PROGRAM).toBeUndefined();
      expect(adapter.active?.options.env.TERM_PROGRAM_VERSION).toBeUndefined();
      expect(adapter.active?.options.env.TERM_SESSION_ID).toBeUndefined();
    },
  );

  test("retains agent metadata in every snapshot", () => {
    const adapter = new FakePtyAdapter();
    const session = new TerminalSession({
      adapter,
      args: ["--no-alt-screen", "Fix tests"],
      cwd: "/repo",
      kind: "agent",
      label: "Fix tests",
      provider: "codex",
      shell: "codex",
    });

    const started = session.start();

    expect(started).toMatchObject({ kind: "agent", provider: "codex" });
    expect(session.snapshot()).toMatchObject({
      kind: "agent",
      provider: "codex",
    });
  });

  test("keeps embedded Codex colors palette-driven across dashboard themes", () => {
    const adapter = new FakePtyAdapter();
    const session = new TerminalSession({
      adapter,
      cwd: "/repo",
      env: { FORCE_COLOR: "3" },
      kind: "agent",
      provider: "codex",
      shell: "codex",
    });

    session.start();

    expect(adapter.active?.options.env.FORCE_COLOR).toBe("1");
  });

  test("renames a live session without restarting its pty", () => {
    const adapter = new FakePtyAdapter();
    const session = new TerminalSession({
      adapter,
      cwd: "/repo",
      label: "Original",
    });
    session.start();

    expect(session.setLabel("Renamed")).toMatchObject({ label: "Renamed" });
    expect(session.snapshot().label).toBe("Renamed");
    expect(adapter.spawned).toHaveLength(1);
  });

  test("writes input and resizes the active pty", () => {
    const adapter = new FakePtyAdapter();
    const session = new TerminalSession({
      adapter,
      cwd: "/repo",
      shell: "/bin/zsh",
    });

    session.start({ cols: 80, rows: 24 });
    session.write("echo ok\r");
    session.resize(120, 40);

    expect(adapter.active?.writes).toEqual(["echo ok\r"]);
    expect(adapter.active?.sizes).toEqual([{ cols: 120, rows: 40 }]);
    expect(session.snapshot()).toMatchObject({
      cols: 120,
      rows: 40,
      state: "running",
    });
  });

  test("restart kills the old pty and creates a new one", () => {
    const adapter = new FakePtyAdapter();
    const session = new TerminalSession({
      adapter,
      cwd: "/repo",
      shell: "/bin/zsh",
    });

    session.start({ cols: 80, rows: 24 });
    const first = adapter.active;
    session.restart({ cols: 90, rows: 25 });

    expect(first?.killed).toBe(true);
    expect(first?.signal).toBe("SIGHUP");
    expect(adapter.spawned).toHaveLength(2);
    expect(adapter.active?.options.cols).toBe(90);
    expect(adapter.active?.options.rows).toBe(25);
  });

  test("records exit state from the pty", () => {
    const adapter = new FakePtyAdapter();
    const session = new TerminalSession({
      adapter,
      cwd: "/repo",
      shell: "/bin/zsh",
    });

    session.start({ cols: 80, rows: 24 });
    adapter.active?.emitExit({ exitCode: 7 });

    expect(session.snapshot()).toMatchObject({
      exit: { exitCode: 7 },
      state: "exited",
    });
  });
});
