import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import {
  ConfigStore,
  ConfigValidationError,
  defaultGlobalConfigPath,
} from "../core/config-store.js";
import { DbPeek } from "../core/db-peek.js";
import { ErrorInbox } from "../core/error-inbox.js";
import { LogStore } from "../core/log-store.js";
import { ProcessManager } from "../core/process-manager.js";
import { ReproBundleBuilder } from "../core/repro-bundle.js";
import {
  TerminalSessionManager,
  type TerminalSessionManagerLike,
} from "../core/terminal-manager.js";
import type {
  TerminalSessionLike,
  TerminalSize,
  TerminalSnapshot,
} from "../core/terminal-session.js";
import { TestRunner } from "../core/test-runner.js";
import { TimelineStore } from "../core/timeline-store.js";
import { ToolCallStore } from "../core/tool-call-store.js";
import { sendHtml, sendJson } from "./http-utils.js";
import { routes, type RouteServices } from "./routes/index.js";
import { errorMessage } from "./routes/context.js";

export interface WebServerOptions {
  configPath?: string;
  cwd?: string;
  logDir?: string;
  port?: number;
  terminalManager?: TerminalSessionManagerLike;
  toolCallStore?: ToolCallStore;
}

export interface RunningWebServer {
  url: string;
  port: number;
  stop(): Promise<void>;
}

export interface WebServerApp {
  start(): Promise<RunningWebServer>;
}

export function createWebServer(options: WebServerOptions = {}): WebServerApp {
  const configStore = new ConfigStore(
    options.configPath ?? defaultGlobalConfigPath(),
  );
  const timelineStore = new TimelineStore({
    baseDir: timelineBaseDir(options.logDir),
  });
  const logStore = new LogStore({
    baseDir: options.logDir ?? resolve(process.cwd(), ".nomoreide/logs"),
    timelineStore,
  });
  const manager = new ProcessManager({ configStore, logStore, timelineStore });
  manager.installShutdownHandlers();
  const cwd = options.cwd ?? process.cwd();
  const toolCallStore = options.toolCallStore ?? new ToolCallStore();
  const errorInbox = new ErrorInbox({ logStore, configStore, cwd });
  const dbPeek = new DbPeek({ configStore });
  const testRunner = new TestRunner({ logStore, configStore, cwd });
  const terminalManager =
    options.terminalManager ?? new TerminalSessionManager({ cwd });
  const reproBundle = new ReproBundleBuilder({
    errorInbox,
    manager,
    reproDir: resolve(cwd, ".nomoreide/repros"),
  });

  const services: RouteServices = {
    configStore,
    cwd,
    dbPeek,
    errorInbox,
    logStore,
    manager,
    reproBundle,
    testRunner,
    terminalManager,
    timelineStore,
    toolCallStore,
  };

  return {
    async start() {
      const server = http.createServer((request, response) => {
        void routeRequest(services, request, response);
      });
      const terminalSocketServer = createTerminalSocketServer(terminalManager);
      server.on("upgrade", (request, socket, head) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (url.pathname !== "/api/terminal/socket") {
          socket.destroy();
          return;
        }
        terminalSocketServer.handleUpgrade(request, socket, head, (ws) => {
          terminalSocketServer.emit("connection", ws, request);
        });
      });
      const port = options.port ?? 4317;

      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(port, "127.0.0.1", () => resolveListen());
      });

      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;

      return {
        port: actualPort,
        url: `http://127.0.0.1:${actualPort}`,
        async stop() {
          terminalManager.disposeAll();
          terminalSocketServer.close();
          await manager.stopAll();
          await new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => {
              if (error) {
                rejectClose(error);
                return;
              }
              resolveClose();
            });
          });
        },
      };
    },
  };
}

function createTerminalSocketServer(
  terminalManager: TerminalSessionManagerLike,
): WebSocketServer {
  const server = new WebSocketServer({ noServer: true });
  server.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const id = url.searchParams.get("id") ?? "term_default";
    const size = socketSize(url);
    // `ensure` re-attaches to an existing tab (start is a no-op when running)
    // or lazily spawns one so a freshly-added tab works before its POST lands.
    const session = terminalManager.ensure(id, size);
    sendTerminalMessage(socket, stateMessage(session.snapshot()));
    const outputSubscription = session.onOutput((data) => {
      sendTerminalMessage(socket, { data, type: "output" });
    });
    const stateSubscription = session.onState((snapshot) => {
      sendTerminalMessage(socket, stateMessage(snapshot));
    });

    socket.on("message", (data) => {
      try {
        handleTerminalSocketMessage(session, data);
      } catch {
        sendTerminalMessage(socket, {
          error: "Invalid terminal socket message.",
          type: "error",
        });
      }
    });
    socket.on("close", () => {
      // Leave the PTY running so the tab survives reloads; only drop listeners.
      outputSubscription.dispose();
      stateSubscription.dispose();
    });
  });
  return server;
}

function handleTerminalSocketMessage(
  session: TerminalSessionLike,
  data: RawData,
): void {
  const message = JSON.parse(data.toString()) as Record<string, unknown>;
  if (message.type === "input" && typeof message.data === "string") {
    session.write(message.data);
    return;
  }
  if (message.type === "resize") {
    const size = normalizeSize(message);
    session.resize(size.cols, size.rows);
    return;
  }
  if (message.type === "restart") {
    session.restart(normalizeSize(message));
    return;
  }
  if (message.type === "stop") {
    session.stop();
  }
}

function socketSize(url: URL): TerminalSize {
  return {
    cols: normalizeDimension(url.searchParams.get("cols"), 80),
    rows: normalizeDimension(url.searchParams.get("rows"), 24),
  };
}

function normalizeSize(input: Record<string, unknown>): TerminalSize {
  return {
    cols: normalizeDimension(input.cols, 80),
    rows: normalizeDimension(input.rows, 24),
  };
}

function normalizeDimension(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function stateMessage(snapshot: TerminalSnapshot): Record<string, unknown> {
  return {
    cols: snapshot.cols,
    cwd: snapshot.cwd,
    error: snapshot.error,
    exit: snapshot.exit,
    rows: snapshot.rows,
    shell: snapshot.shell,
    state: snapshot.state,
    type: "state",
  };
}

function sendTerminalMessage(
  socket: Pick<WebSocket, "readyState" | "send">,
  message: Record<string, unknown>,
): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

/** Match the request against the route registry, falling back to a 404. */
async function routeRequest(
  services: RouteServices,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const method = request.method ?? "GET";

  try {
    for (const route of routes) {
      const params = route.match(method, url);
      if (params) {
        await route.handle({ ...services, request, response, url, params });
        return;
      }
    }
    sendHtml(response, "Not found", 404);
  } catch (error) {
    sendJson(
      response,
      { ok: false, error: errorMessage(error) },
      error instanceof ConfigValidationError ? 400 : 500,
    );
  }
}

function timelineBaseDir(logDir: string | undefined): string {
  return logDir ? dirname(resolve(logDir)) : resolve(process.cwd(), ".nomoreide");
}
