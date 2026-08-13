import { describe, expect, test } from "vitest";
import type {
  PtyAdapter,
  PtyProcess,
  TerminalExit,
} from "../src/core/terminal-session.js";
import { TerminalSessionManager } from "../src/core/terminal-manager.js";
import type {
  ExternalTerminalAttachment,
  ExternalTerminalCallbacks,
  ExternalTerminalOpenOptions,
} from "../src/core/external-terminal.js";

class FakePtyProcess implements PtyProcess {
  killed = false;
  readonly writes: string[] = [];
  readonly sizes: Array<[number, number]> = [];
  private dataCallback: (data: string) => void = () => {};
  write(data: string): void { this.writes.push(data); }
  resize(cols: number, rows: number): void { this.sizes.push([cols, rows]); }
  kill(): void {
    this.killed = true;
  }
  onData(callback: (data: string) => void): { dispose(): void } {
    this.dataCallback = callback;
    return { dispose: () => {} };
  }
  onExit(_callback: (exit: TerminalExit) => void): { dispose(): void } {
    return { dispose: () => {} };
  }
  emitData(data: string): void { this.dataCallback(data); }
}

class FakeExternalLauncher {
  callbacks?: ExternalTerminalCallbacks;
  options?: ExternalTerminalOpenOptions;
  replay?: Buffer;
  revoked = false;

  async open(callbacks: ExternalTerminalCallbacks, options: ExternalTerminalOpenOptions = {}): Promise<ExternalTerminalAttachment> {
    this.callbacks = callbacks;
    this.options = options;
    this.replay = callbacks.attached() ?? undefined;
    return {
      lease: options.lease ?? "lease",
      sendOutput: () => true,
      revoke: () => { this.revoked = true; },
    };
  }
}

class FakePtyAdapter implements PtyAdapter {
  readonly spawned: FakePtyProcess[] = [];
  spawn(): PtyProcess {
    const process = new FakePtyProcess();
    this.spawned.push(process);
    return process;
  }
}

function makeManager(): {
  manager: TerminalSessionManager;
  adapters: FakePtyAdapter[];
} {
  const adapters: FakePtyAdapter[] = [];
  const manager = new TerminalSessionManager({
    cwd: "/repo",
    adapterFactory: () => {
      const adapter = new FakePtyAdapter();
      adapters.push(adapter);
      return adapter;
    },
  });
  return { manager, adapters };
}

describe("TerminalSessionManager", () => {
  test("create returns a unique id and a running snapshot", () => {
    const { manager } = makeManager();
    const a = manager.create({ cols: 80, rows: 24 });
    const b = manager.create();

    expect(a.id).not.toBe(b.id);
    expect(a.state).toBe("running");
    expect(a.cwd).toBe("/repo");
    expect(a.kind).toBeUndefined();
    expect(a.provider).toBeUndefined();
    expect(manager.list().map((s) => s.id)).toEqual([a.id, b.id]);
  });

  test("create retains agent metadata in create, snapshot, and list", () => {
    const { manager } = makeManager();

    const created = manager.create({}, {
      shell: "codex",
      args: ["--no-alt-screen", "Fix tests"],
      label: "Fix tests",
      kind: "agent",
      provider: "codex",
    });

    expect(created).toMatchObject({ kind: "agent", provider: "codex" });
    expect(manager.get(created.id)?.snapshot()).toMatchObject({
      kind: "agent",
      provider: "codex",
    });
    expect(manager.list()).toContainEqual(
      expect.objectContaining({
        id: created.id,
        kind: "agent",
        provider: "codex",
      }),
    );
  });

  test("ensure reuses an existing id and lazily creates unknown ids", () => {
    const { manager, adapters } = makeManager();
    const created = manager.ensure("term_x", { cols: 100, rows: 30 });
    const again = manager.ensure("term_x");

    expect(created).toBe(again);
    expect(adapters).toHaveLength(1);
    expect(manager.list()).toHaveLength(1);
    expect(adapters[0]?.spawned[0]?.sizes).toEqual([]);
  });

  test("close disposes one session without touching the others", () => {
    const { manager } = makeManager();
    const a = manager.create();
    const b = manager.create();

    expect(manager.close(a.id)).toBe(true);
    expect(manager.get(a.id)).toBeUndefined();
    expect(manager.get(b.id)).toBeDefined();
    expect(manager.close(a.id)).toBe(false);
  });

  test("disposeAll clears every session", () => {
    const { manager } = makeManager();
    manager.create();
    manager.create();

    manager.disposeAll();

    expect(manager.list()).toEqual([]);
  });

  test("createWithId reattaches to the same session instead of duplicating", () => {
    const { manager, adapters } = makeManager();
    const first = manager.createWithId("svc:api", { label: "api" });
    const second = manager.createWithId("svc:api", { label: "api" });

    expect(first.id).toBe("svc:api");
    expect(second.id).toBe("svc:api");
    expect(manager.list()).toHaveLength(1);
    expect(adapters).toHaveLength(1); // spawned once
    expect(first.kind).toBeUndefined();
    expect(first.provider).toBeUndefined();
  });

  test("renames a live session in place and keeps it in subsequent lists", () => {
    const { manager, adapters } = makeManager();
    const created = manager.create({}, { label: "Original" });

    expect(manager.rename(created.id, "Renamed")).toMatchObject({
      id: created.id,
      label: "Renamed",
    });
    expect(manager.list()).toContainEqual(
      expect.objectContaining({ id: created.id, label: "Renamed" }),
    );
    expect(manager.rename("missing", "Ignored")).toBeUndefined();
    expect(adapters).toHaveLength(1);
  });

  test("detach keeps the session alive so a reopen can reattach", () => {
    const { manager } = makeManager();
    manager.ensure("term_x");
    manager.detach("term_x");

    expect(manager.get("term_x")).toBeDefined();
  });

  test("an idle session is reaped after the idle timeout", async () => {
    const adapters: FakePtyAdapter[] = [];
    const manager = new TerminalSessionManager({
      cwd: "/repo",
      idleTimeoutMs: 20,
      disconnectGraceMs: 0,
      adapterFactory: () => {
        const adapter = new FakePtyAdapter();
        adapters.push(adapter);
        return adapter;
      },
    });
    manager.ensure("term_idle");
    expect(manager.get("term_idle")).toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(manager.get("term_idle")).toBeUndefined();
  });

  test("moves one running agent between dock and external Terminal without restarting", async () => {
    const adapter = new FakePtyAdapter();
    const launcher = new FakeExternalLauncher();
    const manager = new TerminalSessionManager({
      cwd: "/repo",
      adapterFactory: () => adapter,
      externalTerminalLauncher: launcher,
    });
    const events: string[] = [];
    manager.onSessionChanged((session) => events.push(session.presentation));
    const created = manager.create({}, {
      kind: "agent",
      label: "Fix the parser",
      provider: "codex",
    });
    const pty = adapter.spawned[0]!;
    pty.emitData("opening output\n");

    const external = await manager.openInSystemTerminal(created.id);

    expect(external.presentation).toBe("terminal");
    expect(launcher.options?.title).toBe("🟢 CODEX · Fix the parser · NoMoreIDE");
    expect(launcher.replay?.toString()).toBe("opening output\n");
    expect(manager.writeFromDock(created.id, "blocked")).toBe(false);
    expect(manager.insertAgentPrompt(created.id, "Review this\nwithout submitting")).toMatchObject({
      id: created.id,
      presentation: "terminal",
    });
    expect(manager.resizeFromDock(created.id, 120, 40)).toBe(false);
    manager.ensure(created.id, { cols: 140, rows: 50 });
    expect(pty.sizes).not.toContainEqual([140, 50]);
    launcher.callbacks?.input(Buffer.from("from terminal"));
    const emoji = Buffer.from("😀");
    launcher.callbacks?.input(emoji.subarray(0, 2));
    launcher.callbacks?.input(emoji.subarray(2));
    launcher.callbacks?.resize(100, 32);
    expect(pty.writes).toEqual([
      "\u001b[200~Review this\rwithout submitting\u001b[201~",
      "from terminal",
      "😀",
    ]);
    expect(pty.sizes).toContainEqual([100, 31]);
    expect(pty.sizes).toContainEqual([100, 32]);
    expect(events).toContain("terminalLaunching");
    expect(events).toContain("terminal");

    launcher.callbacks?.detached();
    expect(manager.list().find((item) => item.id === created.id)?.presentation).toBe("dock");
    expect(pty.killed).toBe(false);

    await manager.openInSystemTerminal(created.id);
    expect(manager.reclaimToDock(created.id)?.presentation).toBe("dock");
    expect(launcher.revoked).toBe(true);
    expect(manager.writeFromDock(created.id, "from dock")).toBe(true);
    expect(manager.insertAgentPrompt(created.id, "dock prompt").presentation).toBe("dock");
    expect(pty.writes).toEqual([
      "\u001b[200~Review this\rwithout submitting\u001b[201~",
      "from terminal",
      "😀",
      "from dock",
      "\u001b[200~dock prompt\u001b[201~",
    ]);
  });

  test("guards trusted prompt insertion by session type, state, presentation, and content", async () => {
    let finishOpen: (() => void) | undefined;
    const opening = new Promise<void>((resolve) => { finishOpen = resolve; });
    const manager = new TerminalSessionManager({
      cwd: "/repo",
      adapterFactory: () => new FakePtyAdapter(),
      externalTerminalLauncher: {
        async open(_callbacks, options = {}) {
          await opening;
          return { lease: options.lease ?? "lease", sendOutput: () => true, revoke() {} };
        },
      },
    });
    const agent = manager.create({}, { kind: "agent", provider: "claude" });
    const shell = manager.create({}, { kind: "shell" });

    expect(() => manager.insertAgentPrompt("missing", "prompt")).toThrow(/Unknown/);
    expect(() => manager.insertAgentPrompt(shell.id, "prompt")).toThrow(/Only agent/);
    expect(() => manager.insertAgentPrompt(agent.id, "bad\u001bprompt")).toThrow(/control/);
    expect(() => manager.insertAgentPrompt(agent.id, "bad\rprompt")).toThrow(/control/);

    const openingRequest = manager.openInSystemTerminal(agent.id);
    expect(() => manager.insertAgentPrompt(agent.id, "prompt")).toThrow(/while Terminal is opening/);
    finishOpen?.();
    await openingRequest;
    manager.get(agent.id)?.stop();
    expect(() => manager.insertAgentPrompt(agent.id, "prompt")).toThrow(/running agent/);
  });

  test("rejects external presentation for non-agent sessions", async () => {
    const launcher = new FakeExternalLauncher();
    const manager = new TerminalSessionManager({
      cwd: "/repo",
      adapterFactory: () => new FakePtyAdapter(),
      externalTerminalLauncher: launcher,
    });
    const shell = manager.create({}, { kind: "shell" });

    await expect(manager.openInSystemTerminal(shell.id)).rejects.toThrow(/Only agent sessions/);
  });

  test("an external attachment cancels the never-connected dock grace timer", async () => {
    const manager = new TerminalSessionManager({
      cwd: "/repo",
      adapterFactory: () => new FakePtyAdapter(),
      disconnectGraceMs: 10,
      idleTimeoutMs: 0,
      externalTerminalLauncher: new FakeExternalLauncher(),
    });
    const agent = manager.create({}, { kind: "agent", provider: "claude" });

    await manager.openInSystemTerminal(agent.id);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(manager.get(agent.id)).toBeDefined();
  });

  test("keeps only the newest bounded replay bytes", async () => {
    const adapter = new FakePtyAdapter();
    const launcher = new FakeExternalLauncher();
    const manager = new TerminalSessionManager({
      cwd: "/repo",
      adapterFactory: () => adapter,
      externalTerminalLauncher: launcher,
    });
    const agent = manager.create({}, { kind: "agent", provider: "codex" });
    adapter.spawned[0]?.emitData("old".repeat(400_000));
    adapter.spawned[0]?.emitData("new-tail");

    await manager.openInSystemTerminal(agent.id);

    expect(launcher.replay).toHaveLength(1024 * 1024);
    expect(launcher.replay?.subarray(-8).toString()).toBe("new-tail");
  });
});
