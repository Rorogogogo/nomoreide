# Web Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build a real terminal page inside the NoMoreIDE web UI.

**Architecture:** Add a small `TerminalSession` core wrapper around `node-pty`, expose it through one WebSocket endpoint on the existing localhost web server, then render it in React with `@xterm/xterm`. Keep the first version to one local server-owned session that reattaches across browser reconnects.

**Tech Stack:** TypeScript, Node HTTP upgrade handling, `node-pty`, `ws`, React, `@xterm/xterm`, `@xterm/addon-fit`, Vitest.

---

## File Structure

- Create `src/core/terminal-session.ts`: owns PTY lifecycle, state, output subscription, input, resize, restart, stop, and cleanup. Uses an injectable adapter for tests.
- Create `test/terminal-session.test.ts`: verifies lifecycle without requiring native PTY bindings.
- Modify `src/web/routes/context.ts`: add `terminalSession` to shared route services.
- Modify `src/web/server.ts`: instantiate `TerminalSession`, handle `/api/terminal/socket` upgrades with `ws`, and clean up terminal on server stop.
- Create `test/web-terminal.test.ts`: verifies WebSocket input/output/resize/restart behavior with a fake terminal adapter.
- Create `src/web/client/src/features/terminal/terminal-view.tsx`: React terminal page using xterm and fit addon.
- Modify `src/web/client/src/app.tsx`: add Terminal navigation, `/terminal` route state, header title, and view mount.
- Modify `src/web/routes/shell-routes.ts`: serve the SPA shell for `/terminal`.
- Modify `package.json` and lockfile: add `@xterm/xterm`, `@xterm/addon-fit`, `node-pty`, `ws`, and `@types/ws`.

## Task 1: Dependencies

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [x] **Step 1: Install runtime and type dependencies**

Run:

```bash
npm install @xterm/xterm @xterm/addon-fit node-pty ws
npm install -D @types/ws
```

Expected: `package.json` and `package-lock.json` include the new packages.

- [x] **Step 2: Verify dependency tree resolves**

Run:

```bash
npm test -- --run terminal-session
```

Expected initially: no matching test files or a missing test failure after Task 2 adds tests.

## Task 2: Core Terminal Session

**Files:**
- Create: `src/core/terminal-session.ts`
- Create: `test/terminal-session.test.ts`

- [x] **Step 1: Write failing core tests**

Create tests that use a fake PTY adapter. Required cases:

```ts
test("starts a shell in the configured cwd and emits output", async () => {
  const adapter = new FakePtyAdapter();
  const session = new TerminalSession({ cwd: "/repo", adapter, shell: "/bin/zsh" });
  const output: string[] = [];
  session.onOutput((chunk) => output.push(chunk));

  session.start({ cols: 100, rows: 30 });
  adapter.active?.emitData("ready");

  expect(adapter.active?.file).toBe("/bin/zsh");
  expect(adapter.active?.options.cwd).toBe("/repo");
  expect(adapter.active?.options.cols).toBe(100);
  expect(output).toEqual(["ready"]);
});

test("writes input and resizes the active pty", () => {
  const adapter = new FakePtyAdapter();
  const session = new TerminalSession({ cwd: "/repo", adapter, shell: "/bin/zsh" });

  session.start({ cols: 80, rows: 24 });
  session.write("echo ok\r");
  session.resize(120, 40);

  expect(adapter.active?.writes).toEqual(["echo ok\r"]);
  expect(adapter.active?.sizes).toEqual([{ cols: 120, rows: 40 }]);
});

test("restart kills the old pty and creates a new one", () => {
  const adapter = new FakePtyAdapter();
  const session = new TerminalSession({ cwd: "/repo", adapter, shell: "/bin/zsh" });

  session.start({ cols: 80, rows: 24 });
  const first = adapter.active;
  session.restart({ cols: 90, rows: 25 });

  expect(first?.killed).toBe(true);
  expect(adapter.spawned).toHaveLength(2);
  expect(adapter.active?.options.cols).toBe(90);
});
```

- [x] **Step 2: Run failing tests**

Run:

```bash
npm test -- --run terminal-session
```

Expected: FAIL because `TerminalSession` does not exist.

- [x] **Step 3: Implement core session**

Implement `TerminalSession` with these exported pieces:

```ts
export type TerminalState = "idle" | "running" | "exited" | "error";
export interface TerminalSize { cols: number; rows: number }
export interface TerminalExit { exitCode?: number; signal?: number }
export interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (exit: TerminalExit) => void): { dispose(): void };
}
export interface PtyAdapter {
  spawn(file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number; name: string }): PtyProcess;
}
```

Default adapter dynamically imports `node-pty` inside `start()` so the server can report a clean error if the native dependency fails to load.

- [x] **Step 4: Verify core tests pass**

Run:

```bash
npm test -- --run terminal-session
```

Expected: PASS.

## Task 3: WebSocket Server Endpoint

**Files:**
- Modify: `src/web/routes/context.ts`
- Modify: `src/web/server.ts`
- Create: `test/web-terminal.test.ts`

- [x] **Step 1: Write failing WebSocket tests**

Create tests that start `createWebServer({ terminalSession })` with a fake session. Required cases:

```ts
test("terminal websocket starts the session and forwards output", async () => {
  const fake = new FakeTerminalSession();
  server = await createWebServer({ cwd: tempDir, logDir: join(tempDir, "logs"), port: 0, terminalSession: fake }).start();
  const socket = new WebSocket(server.url.replace("http", "ws") + "/api/terminal/socket?cols=100&rows=30");

  const first = await nextMessage(socket);

  expect(fake.startedWith).toEqual({ cols: 100, rows: 30 });
  expect(JSON.parse(first)).toMatchObject({ type: "state", state: "running", cwd: tempDir });
});

test("terminal websocket forwards input and resize messages", async () => {
  const fake = new FakeTerminalSession();
  server = await createWebServer({ cwd: tempDir, logDir: join(tempDir, "logs"), port: 0, terminalSession: fake }).start();
  const socket = await openTerminalSocket(server.url);

  socket.send(JSON.stringify({ type: "input", data: "echo ok\r" }));
  socket.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
  await eventually(() => expect(fake.writes).toContain("echo ok\r"));

  expect(fake.resizes).toContainEqual({ cols: 120, rows: 40 });
});
```

- [x] **Step 2: Run failing WebSocket tests**

Run:

```bash
npm test -- --run web-terminal
```

Expected: FAIL because the server has no terminal WebSocket endpoint.

- [x] **Step 3: Implement WebSocket endpoint**

Add `terminalSession?: TerminalSessionLike` to `WebServerOptions` for tests. Instantiate a real `TerminalSession` by default. Register `server.on("upgrade", ...)` and accept only `/api/terminal/socket`; destroy other upgrade sockets.

Protocol:

```ts
client -> { "type": "input", "data": "..." }
client -> { "type": "resize", "cols": 120, "rows": 40 }
client -> { "type": "restart", "cols": 100, "rows": 30 }
client -> { "type": "stop" }
server -> { "type": "state", "state": "running", "cwd": "/repo" }
server -> { "type": "output", "data": "..." }
server -> { "type": "error", "error": "..." }
```

- [x] **Step 4: Verify server tests pass**

Run:

```bash
npm test -- --run web-terminal
```

Expected: PASS.

## Task 4: React Terminal Page

**Files:**
- Create: `src/web/client/src/features/terminal/terminal-view.tsx`
- Modify: `src/web/client/src/app.tsx`
- Modify: `src/web/routes/shell-routes.ts`
- Create: `test/terminal-view.test.tsx`

- [x] **Step 1: Write failing UI tests**

Mock `@xterm/xterm` and `@xterm/addon-fit`. Verify:

```ts
test("renders terminal page controls", () => {
  render(<TerminalView />);
  expect(screen.getByText("Terminal")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /restart/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
});
```

- [x] **Step 2: Run failing UI tests**

Run:

```bash
npm test -- --run terminal-view
```

Expected: FAIL because `TerminalView` does not exist.

- [x] **Step 3: Implement UI**

Create `TerminalView` that:

- creates an xterm instance with a compact dark theme and scrollback.
- opens a WebSocket to `/api/terminal/socket`.
- writes `output` messages into xterm.
- sends xterm input as `{ type: "input", data }`.
- fits and sends `{ type: "resize", cols, rows }` on mount and browser resize.
- exposes Stop and Restart icon buttons.

- [x] **Step 4: Wire navigation and shell route**

Update `Page` to include `"terminal"`, route `/terminal`, add sidebar nav with a terminal icon, render `<TerminalView />`, and add `/terminal` to `shellPaths`.

- [x] **Step 5: Verify UI tests pass**

Run:

```bash
npm test -- --run terminal-view
```

Expected: PASS.

## Task 5: Full Verification

**Files:**
- No new files unless fixes are required.

- [x] **Step 1: Run focused tests**

Run:

```bash
npm test -- --run terminal-session web-terminal terminal-view
```

Expected: PASS.

- [x] **Step 2: Run lint**

Run:

```bash
npm run lint
```

Expected: PASS.

- [x] **Step 3: Run build**

Run:

```bash
npm run build
```

Expected: PASS.

- [x] **Step 4: Manual browser verification**

Run:

```bash
npm run dev -- web --port=4317
```

Open `http://127.0.0.1:4317/terminal`, run `pwd`, `echo ok`, then `sleep 10` and press Ctrl+C. Resize the browser and verify the terminal remains usable. Stop the dev server after verification.

