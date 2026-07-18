import { describe, expect, test } from "vitest";
import type {
  PtyAdapter,
  PtyProcess,
  TerminalExit,
} from "../src/core/terminal-session.js";
import { TerminalSessionManager } from "../src/core/terminal-manager.js";

class FakePtyProcess implements PtyProcess {
  killed = false;
  write(): void {}
  resize(): void {}
  kill(): void {
    this.killed = true;
  }
  onData(_callback: (data: string) => void): { dispose(): void } {
    return { dispose: () => {} };
  }
  onExit(_callback: (exit: TerminalExit) => void): { dispose(): void } {
    return { dispose: () => {} };
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
});
