import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import WebSocket from "ws";
import type {
  TerminalSessionInfo,
  TerminalSessionManagerLike,
} from "../src/core/terminal-manager.js";
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
  private counter = 0;

  constructor(private readonly cwd: string) {}

  list(): TerminalSessionInfo[] {
    return [...this.sessions.entries()].map(([id, session]) => ({
      id,
      ...session.snapshot(),
    }));
  }

  create(size: Partial<TerminalSize> = {}): TerminalSessionInfo {
    const id = `term_${++this.counter}`;
    const session = new FakeTerminalSession(this.cwd);
    session.start(size);
    this.sessions.set(id, session);
    return { id, ...session.snapshot() };
  }

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
