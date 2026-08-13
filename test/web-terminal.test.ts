import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import type {
  TerminalSessionInfo,
  TerminalSessionManagerLike,
  TerminalSpawnOptions,
} from "../src/core/terminal-manager.js";
import { ConfigStore } from "../src/core/config-store.js";
import type {
  TerminalSize,
  TerminalSnapshot,
  TerminalState,
} from "../src/core/terminal-session.js";
import { createWebServer } from "../src/web/server.js";

class FakeTerminalSession {
  readonly cwd: string;
  readonly shell = "/bin/zsh";
  label?: string;
  readonly writes: string[] = [];
  readonly resizes: TerminalSize[] = [];
  error?: string;
  startedWith?: TerminalSize;
  restartedWith?: TerminalSize;
  stopped = false;
  state: TerminalState = "idle";
  cols = 80;
  rows = 24;
  private outputListeners = new Set<(chunk: string) => void>();
  private stateListeners = new Set<(snapshot: TerminalSnapshot) => void>();

  constructor(cwd: string, label?: string) {
    this.cwd = cwd;
    this.label = label;
  }

  snapshot(): TerminalSnapshot {
    return {
      cols: this.cols,
      cwd: this.cwd,
      error: this.error,
      label: this.label,
      rows: this.rows,
      shell: this.shell,
      state: this.state,
    };
  }

  start(size: Partial<TerminalSize> = {}): TerminalSnapshot {
    this.startedWith = normalizeSize(size);
    this.cols = this.startedWith.cols;
    this.rows = this.startedWith.rows;
    this.state = "running";
    this.emitState();
    return this.snapshot();
  }

  restart(size: Partial<TerminalSize> = {}): TerminalSnapshot {
    this.restartedWith = normalizeSize(size);
    this.cols = this.restartedWith.cols;
    this.rows = this.restartedWith.rows;
    this.state = "running";
    this.emitState();
    return this.snapshot();
  }

  stop(): TerminalSnapshot {
    this.stopped = true;
    this.state = "exited";
    this.emitState();
    return this.snapshot();
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): TerminalSnapshot {
    this.cols = cols;
    this.rows = rows;
    this.resizes.push({ cols, rows });
    this.emitState();
    return this.snapshot();
  }

  setLabel(label: string): TerminalSnapshot {
    this.label = label;
    return this.snapshot();
  }

  dispose(): void {
    this.stop();
  }

  onOutput(listener: (chunk: string) => void): { dispose(): void } {
    this.outputListeners.add(listener);
    return {
      dispose: () => {
        this.outputListeners.delete(listener);
      },
    };
  }

  onState(listener: (snapshot: TerminalSnapshot) => void): { dispose(): void } {
    this.stateListeners.add(listener);
    return {
      dispose: () => {
        this.stateListeners.delete(listener);
      },
    };
  }

  emitOutput(chunk: string): void {
    for (const listener of this.outputListeners) listener(chunk);
  }

  private emitState(): void {
    const snapshot = this.snapshot();
    for (const listener of this.stateListeners) listener(snapshot);
  }
}

class FakeTerminalManager implements TerminalSessionManagerLike {
  readonly sessions = new Map<string, FakeTerminalSession>();
  readonly ensureSizes: Array<Partial<TerminalSize>> = [];
  /** Options the most recent `create` call received, for assertions. */
  lastCreateOptions?: TerminalSpawnOptions;
  private counter = 0;

  constructor(private readonly cwd: string) {}

  list(): TerminalSessionInfo[] {
    return [...this.sessions.entries()].map(([id, session]) => ({
      id,
      ...session.snapshot(),
    }));
  }

  create(
    size: Partial<TerminalSize> = {},
    options: TerminalSpawnOptions = {},
  ): TerminalSessionInfo {
    this.lastCreateOptions = options;
    const id = `term_${++this.counter}`;
    const session = new FakeTerminalSession(options.cwd ?? this.cwd, options.label);
    session.start(size);
    this.sessions.set(id, session);
    return { id, ...session.snapshot() };
  }

  createWithId(
    id: string,
    options: TerminalSpawnOptions = {},
  ): TerminalSessionInfo {
    const existing = this.sessions.get(id);
    if (existing) return { id, ...existing.snapshot() };
    this.lastCreateOptions = options;
    const session = new FakeTerminalSession(options.cwd ?? this.cwd, options.label);
    session.start();
    this.sessions.set(id, session);
    return { id, ...session.snapshot() };
  }

  touch(): void {}

  detach(): void {}

  rename(id: string, label: string): TerminalSessionInfo | undefined {
    const session = this.sessions.get(id);
    return session ? { id, ...session.setLabel(label) } : undefined;
  }

  get(id: string): FakeTerminalSession | undefined {
    return this.sessions.get(id);
  }

  ensure(id: string, size: Partial<TerminalSize> = {}): FakeTerminalSession {
    this.ensureSizes.push(size);
    const existing = this.sessions.get(id);
    if (existing) {
      if (existing.state === "running") {
        if (size.cols && size.rows) existing.resize(size.cols, size.rows);
      } else {
        existing.start(size);
      }
      return existing;
    }
    const session = new FakeTerminalSession(this.cwd);
    session.start(size);
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
}

class PresentationTerminalManager extends FakeTerminalManager {
  readonly insertedPrompts: Array<{ id: string; prompt: string }> = [];
  externalTerminalAvailable(): boolean { return true; }

  async openInSystemTerminal(id: string): Promise<TerminalSessionInfo> {
    const session = this.get(id);
    if (!session) throw new Error(`Unknown terminal session: ${id}`);
    return { id, ...session.snapshot(), presentation: "terminal" };
  }

  reclaimToDock(id: string): TerminalSessionInfo | undefined {
    const session = this.get(id);
    return session ? { id, ...session.snapshot(), presentation: "dock" } : undefined;
  }

  insertAgentPrompt(id: string, prompt: string): TerminalSessionInfo {
    const session = this.get(id);
    if (!session) throw new Error(`Unknown terminal session: ${id}`);
    this.insertedPrompts.push({ id, prompt });
    return { id, ...session.snapshot(), kind: "agent", presentation: "terminal" };
  }
}

let tempDir: string;
let server: Awaited<ReturnType<ReturnType<typeof createWebServer>["start"]>>;
let sockets: WebSocket[] = [];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-terminal-"));
});

afterEach(async () => {
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) socket.close();
  }
  sockets = [];
  await server?.stop();
  await rm(tempDir, { recursive: true, force: true });
});

describe("web terminal socket", () => {
  test("starts the terminal session and forwards output", async () => {
    const manager = new FakeTerminalManager(tempDir);
    server = await createWebServer({
      cwd: tempDir,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
      terminalManager: manager,
    }).start();
    const client = await openTerminalSocket(
      `${server.url.replace("http", "ws")}/api/terminal/socket?cols=100&rows=30`,
    );

    const first = await client.nextMessage();
    const fake = manager.get("term_default");
    fake?.emitOutput("ready\r\n");
    const second = await client.nextMessage();

    expect(fake?.startedWith).toEqual({ cols: 100, rows: 30 });
    expect(JSON.parse(first)).toMatchObject({
      cwd: tempDir,
      state: "running",
      type: "state",
    });
    expect(JSON.parse(second)).toEqual({
      data: "ready\r\n",
      type: "output",
    });
  });

  test("reattaches without applying fallback dimensions to a running session", async () => {
    const manager = new FakeTerminalManager(tempDir);
    const existing = manager.createWithId("term_existing");
    manager.get(existing.id)?.resize(132, 43);
    server = await createWebServer({
      cwd: tempDir,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
      terminalManager: manager,
    }).start();

    const client = await openTerminalSocket(
      `${server.url.replace("http", "ws")}/api/terminal/socket?id=${existing.id}`,
    );
    await client.nextMessage();

    expect(manager.ensureSizes.at(-1)).toEqual({});
    expect(manager.get(existing.id)?.snapshot()).toMatchObject({
      cols: 132,
      rows: 43,
      state: "running",
    });
  });

  test("forwards input and resize messages", async () => {
    const manager = new FakeTerminalManager(tempDir);
    server = await createWebServer({
      cwd: tempDir,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
      terminalManager: manager,
    }).start();
    const client = await openTerminalSocket(
      `${server.url.replace("http", "ws")}/api/terminal/socket`,
    );
    await client.nextMessage();
    const fake = manager.get("term_default")!;

    client.socket.send(JSON.stringify({ data: "echo ok\r", type: "input" }));
    client.socket.send(JSON.stringify({ cols: 120, rows: 40, type: "resize" }));

    await eventually(() => expect(fake.writes).toContain("echo ok\r"));
    expect(fake.resizes).toContainEqual({ cols: 120, rows: 40 });
  });

  test("forwards restart, repair, and stop controls", async () => {
    const manager = new FakeTerminalManager(tempDir);
    const repairTerminal = vi.fn();
    server = await createWebServer({
      cwd: tempDir,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
      repairTerminal,
      terminalManager: manager,
    }).start();
    const client = await openTerminalSocket(
      `${server.url.replace("http", "ws")}/api/terminal/socket`,
    );
    await client.nextMessage();
    const fake = manager.get("term_default")!;

    client.socket.send(JSON.stringify({ cols: 90, rows: 25, type: "restart" }));
    await eventually(() =>
      expect(fake.restartedWith).toEqual({ cols: 90, rows: 25 }),
    );

    fake.state = "error";
    fake.error = "posix_spawnp failed.";
    client.socket.send(JSON.stringify({ cols: 91, rows: 26, type: "repair" }));
    await eventually(() => expect(repairTerminal).toHaveBeenCalledOnce());
    expect(fake.restartedWith).toEqual({ cols: 91, rows: 26 });

    client.socket.send(JSON.stringify({ type: "stop" }));
    await eventually(() => expect(fake.stopped).toBe(true));
  });

  test("reports malformed socket messages without closing the server", async () => {
    const manager = new FakeTerminalManager(tempDir);
    server = await createWebServer({
      cwd: tempDir,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
      terminalManager: manager,
    }).start();
    const client = await openTerminalSocket(
      `${server.url.replace("http", "ws")}/api/terminal/socket`,
    );
    await client.nextMessage();

    client.socket.send("{");
    const message = JSON.parse(await client.nextMessage());

    expect(message).toMatchObject({
      error: "Invalid terminal socket message.",
      type: "error",
    });
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });

  test("routes each id to its own session", async () => {
    const manager = new FakeTerminalManager(tempDir);
    server = await createWebServer({
      cwd: tempDir,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
      terminalManager: manager,
    }).start();
    const base = `${server.url.replace("http", "ws")}/api/terminal/socket`;
    const a = await openTerminalSocket(`${base}?id=term_a`);
    const b = await openTerminalSocket(`${base}?id=term_b`);
    await a.nextMessage();
    await b.nextMessage();

    a.socket.send(JSON.stringify({ data: "from-a\r", type: "input" }));

    await eventually(() =>
      expect(manager.get("term_a")?.writes).toContain("from-a\r"),
    );
    expect(manager.get("term_b")?.writes ?? []).not.toContain("from-a\r");
  });

  test("lists, creates, and deletes sessions over REST", async () => {
    const manager = new FakeTerminalManager(tempDir);
    server = await createWebServer({
      cwd: tempDir,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
      terminalManager: manager,
    }).start();

    const created = await fetch(`${server.url}/api/terminal/sessions`, {
      method: "POST",
    });
    expect(created.status).toBe(201);
    const { session } = (await created.json()) as {
      session: TerminalSessionInfo;
    };
    expect(session.id).toBe("term_1");
    // A plain create is a shell, and says so — the dock adopts tabs by kind.
    expect(manager.lastCreateOptions?.kind).toBe("shell");

    const listed = await (
      await fetch(`${server.url}/api/terminal/sessions`)
    ).json();
    expect(listed.sessions.map((s: TerminalSessionInfo) => s.id)).toEqual([
      "term_1",
    ]);

    const renamed = await fetch(
      `${server.url}/api/terminal/sessions/term_1`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "Build watcher" }),
      },
    );
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).session.label).toBe("Build watcher");
    expect(manager.list()[0]?.label).toBe("Build watcher");

    const deleted = await fetch(
      `${server.url}/api/terminal/sessions/term_1`,
      { method: "DELETE" },
    );
    expect((await deleted.json()).ok).toBe(true);
    expect(manager.get("term_1")).toBeUndefined();
  });

  test("validates session rename requests and unknown ids", async () => {
    const manager = new FakeTerminalManager(tempDir);
    server = await createWebServer({
      cwd: tempDir,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
      terminalManager: manager,
    }).start();

    const invalid = await fetch(
      `${server.url}/api/terminal/sessions/missing`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "   " }),
      },
    );
    expect(invalid.status).toBe(400);

    const missing = await fetch(
      `${server.url}/api/terminal/sessions/missing`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "New name" }),
      },
    );
    expect(missing.status).toBe(404);

    const unicodeBoundary = await fetch(
      `${server.url}/api/terminal/sessions/missing`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "😀".repeat(31) }),
      },
    );
    expect(unicodeBoundary.status).toBe(400);
  });
});

describe("external terminal HTTP controls", () => {
  test("inserts a validated prompt through the trusted control without reclaiming", async () => {
    const manager = new PresentationTerminalManager(tempDir);
    const created = manager.create();
    server = await createWebServer({
      cwd: tempDir,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
      terminalManager: manager,
    }).start();
    const path = `${server.url}/api/terminal/sessions/${created.id}/insert-prompt`;

    expect((await fetch(path, { method: "POST" })).status).toBe(403);
    const inserted = await fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nomoreide-terminal-control": "1",
      },
      body: JSON.stringify({ prompt: "Review this\nwithout submitting" }),
    });

    expect(inserted.status).toBe(200);
    expect((await inserted.json()).session.presentation).toBe("terminal");
    expect(manager.insertedPrompts).toEqual([{
      id: created.id,
      prompt: "Review this\nwithout submitting",
    }]);

    const invalid = await fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nomoreide-terminal-control": "1",
      },
      body: JSON.stringify({ prompt: "submit\r" }),
    });
    expect(invalid.status).toBe(400);
    expect(manager.insertedPrompts).toHaveLength(1);

    const oversized = await fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nomoreide-terminal-control": "1",
      },
      body: JSON.stringify({ prompt: "x".repeat(512 * 1024 * 6 + 2_000) }),
    });
    expect(oversized.status).toBe(413);
    expect(manager.insertedPrompts).toHaveLength(1);
  });

  test("advertises capability and requires the non-simple control header", async () => {
    const manager = new PresentationTerminalManager(tempDir);
    const created = manager.create();
    server = await createWebServer({
      cwd: tempDir,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
      terminalManager: manager,
    }).start();

    const capabilities = await fetch(`${server.url}/api/terminal/capabilities`);
    expect(await capabilities.json()).toEqual({ externalTerminal: true });

    const path = `${server.url}/api/terminal/sessions/${created.id}/open-system-terminal`;
    expect((await fetch(path, { method: "POST" })).status).toBe(403);
    const opened = await fetch(path, {
      method: "POST",
      headers: { "x-nomoreide-terminal-control": "1" },
    });
    expect(opened.status).toBe(200);
    expect((await opened.json()).session.presentation).toBe("terminal");

    const reclaimed = await fetch(
      `${server.url}/api/terminal/sessions/${created.id}/reclaim-dock`,
      {
        method: "POST",
        headers: { "x-nomoreide-terminal-control": "1" },
      },
    );
    expect((await reclaimed.json()).session.presentation).toBe("dock");
  });

  test("rejects unbounded or path-like terminal ids", async () => {
    const manager = new PresentationTerminalManager(tempDir);
    server = await createWebServer({
      cwd: tempDir,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
      terminalManager: manager,
    }).start();
    const response = await fetch(
      `${server.url}/api/terminal/sessions/${encodeURIComponent("../../tmp/socket")}/reclaim-dock`,
      {
        method: "POST",
        headers: { "x-nomoreide-terminal-control": "1" },
      },
    );
    expect(response.status).toBe(400);
  });

  test("keeps existing service ids with spaces and dots closable", async () => {
    const manager = new PresentationTerminalManager(tempDir);
    const id = "svc:web api.v1";
    manager.createWithId(id);
    server = await createWebServer({
      cwd: tempDir,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
      terminalManager: manager,
    }).start();

    const response = await fetch(
      `${server.url}/api/terminal/sessions/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(200);
    expect(manager.get(id)).toBeUndefined();
  });

  test("streams an authoritative session snapshot when SSE connects", async () => {
    const manager = new PresentationTerminalManager(tempDir);
    const created = manager.create();
    server = await createWebServer({
      cwd: tempDir,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
      terminalManager: manager,
    }).start();
    const abort = new AbortController();
    const response = await fetch(`${server.url}/api/terminal/events`, {
      signal: abort.signal,
    });
    const chunk = await response.body?.getReader().read();
    const text = new TextDecoder().decode(chunk?.value);

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toContain("event: session");
    expect(text).toContain(created.id);
    abort.abort();
  });
});

describe("service-scoped terminal sessions", () => {
  test("spawns in the service's cwd with merged env and a label", async () => {
    const configPath = join(tempDir, "config.json");
    const serviceCwd = join(tempDir, "api");
    await new ConfigStore(configPath).registerService({
      name: "api",
      command: "npm run dev",
      cwd: serviceCwd,
      env: { FOO: "bar" },
    });
    const manager = new FakeTerminalManager(tempDir);
    server = await createWebServer({
      configPath,
      cwd: tempDir,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
      terminalManager: manager,
    }).start();

    const created = await fetch(`${server.url}/api/terminal/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serviceName: "api" }),
    });

    expect(created.status).toBe(201);
    const { session } = (await created.json()) as {
      session: TerminalSessionInfo;
    };
    expect(session.label).toBe("api");
    expect(manager.lastCreateOptions?.kind).toBe("service");
    expect(manager.lastCreateOptions?.cwd).toBe(serviceCwd);
    expect(manager.lastCreateOptions?.label).toBe("api");
    // Inherited env is preserved and the service's vars are layered on top.
    expect(manager.lastCreateOptions?.env?.FOO).toBe("bar");
    expect(manager.lastCreateOptions?.env?.PATH).toBe(process.env.PATH);
  });

  test("reopening a service reuses the same session id", async () => {
    const configPath = join(tempDir, "config.json");
    await new ConfigStore(configPath).registerService({
      name: "api",
      command: "npm run dev",
      cwd: tempDir,
    });
    const manager = new FakeTerminalManager(tempDir);
    server = await createWebServer({
      configPath,
      cwd: tempDir,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
      terminalManager: manager,
    }).start();

    const open = () =>
      fetch(`${server.url}/api/terminal/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serviceName: "api" }),
      }).then((res) => res.json() as Promise<{ session: TerminalSessionInfo }>);

    const first = await open();
    const second = await open();

    expect(first.session.id).toBe("svc:api");
    expect(second.session.id).toBe("svc:api");
    expect(manager.sessions.size).toBe(1);
  });

  test("404s for an unknown service", async () => {
    const manager = new FakeTerminalManager(tempDir);
    server = await createWebServer({
      configPath: join(tempDir, "config.json"),
      cwd: tempDir,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
      terminalManager: manager,
    }).start();

    const res = await fetch(`${server.url}/api/terminal/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serviceName: "ghost" }),
    });

    expect(res.status).toBe(404);
    expect(manager.lastCreateOptions).toBeUndefined();
  });

  test("spawns a docker-compose exec session", async () => {
    const configPath = join(tempDir, "config.json");
    await new ConfigStore(configPath).registerService({
      name: "db",
      kind: "docker-compose",
      cwd: tempDir,
      composeService: "db",
    });
    const manager = new FakeTerminalManager(tempDir);
    server = await createWebServer({
      configPath,
      cwd: tempDir,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
      terminalManager: manager,
    }).start();

    const res = await fetch(`${server.url}/api/terminal/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serviceName: "db" }),
    });

    expect(res.status).toBe(201);
    expect(manager.lastCreateOptions?.shell).toBe("docker");
    expect(manager.lastCreateOptions?.args).toEqual([
      "compose",
      "exec",
      "db",
      "sh",
    ]);
    expect(manager.lastCreateOptions?.label).toBe("db");
  });
});

describe("agent terminal sessions", () => {
  test("creates a Codex session from a provider and prompt", async () => {
    const manager = new FakeTerminalManager(tempDir);
    server = await createWebServer({
      configPath: join(tempDir, "config.json"),
      cwd: tempDir,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
      terminalManager: manager,
    }).start();

    const res = await fetch(`${server.url}/api/terminal/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: {
          provider: "codex",
          prompt: "Fix the failing test",
          label: "Fix failing test",
        },
      }),
    });

    expect(res.status).toBe(201);
    expect(manager.lastCreateOptions).toEqual({
      args: ["--no-alt-screen", "Fix the failing test"],
      cwd: tempDir,
      kind: "agent",
      label: "Fix failing test",
      provider: "codex",
      shell: "codex",
    });
    expect(manager.sessions.get("term_1")?.writes).toEqual([]);
  });

  test("preserves surrounding whitespace in a valid agent prompt", async () => {
    const manager = new FakeTerminalManager(tempDir);
    server = await createWebServer({
      cwd: tempDir,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
      terminalManager: manager,
    }).start();
    const prompt = "  First line\nSecond line\n  ";

    const res = await fetch(`${server.url}/api/terminal/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: { provider: "codex", prompt } }),
    });

    expect(res.status).toBe(201);
    expect(manager.lastCreateOptions?.args).toEqual(["--no-alt-screen", prompt]);
    expect(manager.sessions.get("term_1")?.writes).toEqual([]);
  });

  test("resumes an existing provider conversation without a new prompt", async () => {
    const manager = new FakeTerminalManager(tempDir);
    server = await createWebServer({
      cwd: tempDir,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
      terminalManager: manager,
    }).start();
    const resumeId = "dce2b69c-0fb4-4bd3-b456-b2bef4230c81";

    const res = await fetch(`${server.url}/api/terminal/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: { provider: "claude", prompt: "", resumeId },
      }),
    });

    expect(res.status).toBe(201);
    expect(manager.lastCreateOptions).toMatchObject({
      args: ["--resume", resumeId],
      kind: "agent",
      provider: "claude",
      shell: "claude",
    });
  });

  test("spawns with the model the request names", async () => {
    const manager = new FakeTerminalManager(tempDir);
    server = await createWebServer({
      cwd: tempDir,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
      terminalManager: manager,
    }).start();

    const res = await fetch(`${server.url}/api/terminal/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: { provider: "claude", prompt: "Fix it", model: "opus" },
      }),
    });

    expect(res.status).toBe(201);
    expect(manager.lastCreateOptions?.args).toEqual(["--model", "opus", "Fix it"]);
  });

  test("falls back to the provider's saved model pin", async () => {
    const manager = new FakeTerminalManager(tempDir);
    const configPath = join(tempDir, "config.json");
    await new ConfigStore(configPath).setChatModel("codex", "gpt-5-codex");
    server = await createWebServer({
      configPath,
      cwd: tempDir,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
      terminalManager: manager,
    }).start();

    const res = await fetch(`${server.url}/api/terminal/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: { provider: "codex", prompt: "" } }),
    });

    expect(res.status).toBe(201);
    expect(manager.lastCreateOptions?.args).toEqual([
      "--no-alt-screen",
      "-m",
      "gpt-5-codex",
    ]);
  });

  test("rejects a model name that could be read as a flag", async () => {
    const manager = new FakeTerminalManager(tempDir);
    server = await createWebServer({
      cwd: tempDir,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
      terminalManager: manager,
    }).start();

    const res = await fetch(`${server.url}/api/terminal/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: {
          provider: "claude",
          prompt: "",
          model: "--dangerously-skip-permissions",
        },
      }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Invalid model name");
    expect(manager.lastCreateOptions).toBeUndefined();
  });

  test("opens an interactive provider session without an initial prompt", async () => {
    const manager = new FakeTerminalManager(tempDir);
    server = await createWebServer({
      cwd: tempDir,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
      terminalManager: manager,
    }).start();

    const res = await fetch(`${server.url}/api/terminal/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: { provider: "codex", prompt: "" } }),
    });

    expect(res.status).toBe(201);
    expect(manager.lastCreateOptions).toMatchObject({
      args: ["--no-alt-screen"],
      kind: "agent",
      label: "Codex task",
      provider: "codex",
      shell: "codex",
    });
  });

  test.each([
    ["unknown provider", { provider: "other", prompt: "Do work" }],
    ["null agent", null],
  ])("returns 400 for an %s", async (_name, agent) => {
    const manager = new FakeTerminalManager(tempDir);
    server = await createWebServer({
      cwd: tempDir,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
      terminalManager: manager,
    }).start();

    const res = await fetch(`${server.url}/api/terminal/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toEqual(expect.any(String));
    expect(manager.lastCreateOptions).toBeUndefined();
  });

  test("ignores browser-supplied executable and argument fields", async () => {
    const manager = new FakeTerminalManager(tempDir);
    server = await createWebServer({
      configPath: join(tempDir, "config.json"),
      cwd: tempDir,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
      terminalManager: manager,
    }).start();

    const res = await fetch(`${server.url}/api/terminal/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shell: "malicious-top-level-shell",
        command: "malicious top-level command",
        args: ["malicious-top-level-arg"],
        agent: {
          provider: "codex",
          prompt: "Safe prompt",
          label: `  ${"A".repeat(70)}  `,
          shell: "malicious-nested-shell",
          command: "malicious nested command",
          args: ["malicious-nested-arg"],
        },
      }),
    });

    expect(res.status).toBe(201);
    expect(manager.lastCreateOptions).toEqual({
      args: ["--no-alt-screen", "Safe prompt"],
      cwd: tempDir,
      kind: "agent",
      label: "A".repeat(60),
      provider: "codex",
      shell: "codex",
    });
    expect(manager.sessions.get("term_1")?.writes).toEqual([]);
  });
});

async function openTerminalSocket(url: string): Promise<{
  nextMessage(): Promise<string>;
  socket: WebSocket;
}> {
  const socket = new WebSocket(url);
  const messages: string[] = [];
  const waiters: Array<(message: string) => void> = [];
  socket.on("message", (data) => {
    const message = data.toString();
    const waiter = waiters.shift();
    if (waiter) {
      waiter(message);
      return;
    }
    messages.push(message);
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return {
    nextMessage: () => {
      const message = messages.shift();
      if (message) return Promise.resolve(message);
      return new Promise((resolve, reject) => {
        waiters.push(resolve);
        socket.once("error", reject);
      });
    },
    socket,
  };
}

async function eventually(assertion: () => void): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < 1000) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

function normalizeSize(size: Partial<TerminalSize>): TerminalSize {
  return {
    cols: size.cols ?? 80,
    rows: size.rows ?? 24,
  };
}
