import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
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
  readonly writes: string[] = [];
  readonly resizes: TerminalSize[] = [];
  startedWith?: TerminalSize;
  restartedWith?: TerminalSize;
  stopped = false;
  state: TerminalState = "idle";
  cols = 80;
  rows = 24;
  private outputListeners = new Set<(chunk: string) => void>();
  private stateListeners = new Set<(snapshot: TerminalSnapshot) => void>();

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  snapshot(): TerminalSnapshot {
    return {
      cols: this.cols,
      cwd: this.cwd,
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
    const session = new FakeTerminalSession(options.cwd ?? this.cwd);
    session.start(size);
    this.sessions.set(id, session);
    return { id, ...session.snapshot(), label: options.label };
  }

  createWithId(
    id: string,
    options: TerminalSpawnOptions = {},
  ): TerminalSessionInfo {
    const existing = this.sessions.get(id);
    if (existing) return { id, ...existing.snapshot() };
    this.lastCreateOptions = options;
    const session = new FakeTerminalSession(options.cwd ?? this.cwd);
    session.start();
    this.sessions.set(id, session);
    return { id, ...session.snapshot(), label: options.label };
  }

  touch(): void {}

  detach(): void {}

  get(id: string): FakeTerminalSession | undefined {
    return this.sessions.get(id);
  }

  ensure(id: string, size: Partial<TerminalSize> = {}): FakeTerminalSession {
    const existing = this.sessions.get(id);
    if (existing) {
      existing.start(size);
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

  test("forwards input and resize messages", async () => {
    const manager = new FakeTerminalManager(tempDir);
    server = await createWebServer({
      cwd: tempDir,
      logDir: join(tempDir, "logs"),
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

  test("forwards restart and stop controls", async () => {
    const manager = new FakeTerminalManager(tempDir);
    server = await createWebServer({
      cwd: tempDir,
      logDir: join(tempDir, "logs"),
      port: 0,
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

    client.socket.send(JSON.stringify({ type: "stop" }));
    await eventually(() => expect(fake.stopped).toBe(true));
  });

  test("reports malformed socket messages without closing the server", async () => {
    const manager = new FakeTerminalManager(tempDir);
    server = await createWebServer({
      cwd: tempDir,
      logDir: join(tempDir, "logs"),
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

    const listed = await (
      await fetch(`${server.url}/api/terminal/sessions`)
    ).json();
    expect(listed.sessions.map((s: TerminalSessionInfo) => s.id)).toEqual([
      "term_1",
    ]);

    const deleted = await fetch(
      `${server.url}/api/terminal/sessions/term_1`,
      { method: "DELETE" },
    );
    expect((await deleted.json()).ok).toBe(true);
    expect(manager.get("term_1")).toBeUndefined();
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
      cwd: tempDir,
      logDir: join(tempDir, "logs"),
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
      kind: "agent",
      label: "Fix failing test",
      provider: "codex",
      shell: "codex",
    });
  });

  test.each([
    ["unknown provider", { provider: "other", prompt: "Do work" }],
    ["blank prompt", { provider: "codex", prompt: "   " }],
  ])("returns 400 for an %s", async (_name, agent) => {
    const manager = new FakeTerminalManager(tempDir);
    server = await createWebServer({
      cwd: tempDir,
      logDir: join(tempDir, "logs"),
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
      cwd: tempDir,
      logDir: join(tempDir, "logs"),
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
      kind: "agent",
      label: "A".repeat(60),
      provider: "codex",
      shell: "codex",
    });
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
