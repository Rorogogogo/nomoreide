import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { AgentSessionStore } from "../core/agent-sessions.js";
import {
  ConfigStore,
  ConfigValidationError,
  defaultGlobalConfigPath,
} from "../core/config-store.js";
import { DbPeek } from "../core/db-peek.js";
import { DbWrite } from "../core/db-write.js";
import { ErrorInbox } from "../core/error-inbox.js";
import { FixLoop } from "../core/fix-loop.js";
import { LogStore } from "../core/log-store.js";
import { MetricsStore } from "../core/metrics-store.js";
import { ProcessManager } from "../core/process-manager.js";
import {
  defaultRuntimeRegistryPath,
  ServiceRegistry,
} from "../core/service-registry.js";
import { ApprovalBroker } from "../core/approval-broker.js";
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
import { UsageHistory } from "../core/usage-history.js";
import { buildUsageInfo } from "./usage-info.js";
import { selectedGitCwd } from "./dashboard.js";
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
  const logDir = options.logDir ?? resolve(process.cwd(), ".nomoreide/logs");
  const logStore = new LogStore({
    baseDir: logDir,
    timelineStore,
  });
  const registry = new ServiceRegistry(defaultRuntimeRegistryPath(logDir));
  const manager = new ProcessManager({
    configStore,
    logStore,
    timelineStore,
    registry,
  });
  manager.installShutdownHandlers();
  const metricsStore = new MetricsStore({ manager });
  metricsStore.start();
  const cwd = options.cwd ?? process.cwd();
  const toolCallStore = options.toolCallStore ?? new ToolCallStore();
  const errorInbox = new ErrorInbox({ logStore, configStore, cwd });
  const dbPeek = new DbPeek({ configStore });
  const dbWrite = new DbWrite({ configStore });
  const testRunner = new TestRunner({ logStore, configStore, cwd });
  const terminalManager =
    options.terminalManager ?? new TerminalSessionManager({ cwd });
  const reproBundle = new ReproBundleBuilder({
    errorInbox,
    manager,
    reproDir: resolve(cwd, ".nomoreide/repros"),
  });
  const agentApprovals = new ApprovalBroker();
  const agentSessions = new AgentSessionStore(
    resolve(dirname(resolve(logDir)), "agent-sessions.json"),
  );
  // Persist token/cost over time. A sampler (below) feeds the latest reading in;
  // the store de-dupes so an idle agent doesn't grow the file each tick.
  const usageHistory = new UsageHistory({
    filePath: resolve(dirname(resolve(logDir)), "usage-history.jsonl"),
  });
  // Error → Fix loop: snapshots the working tree of the *selected* repo (where
  // the in-dock agent edits) before handing the repro bundle to the agent.
  const fixLoop = new FixLoop({
    reproBundle,
    agentSessions,
    resolveRepoPath: () => selectedGitCwd(configStore, cwd),
  });

  const services: RouteServices = {
    agentApprovals,
    agentSessions,
    configStore,
    cwd,
    dbPeek,
    dbWrite,
    errorInbox,
    fixLoop,
    logStore,
    manager,
    metricsStore,
    reproBundle,
    testRunner,
    terminalManager,
    timelineStore,
    toolCallStore,
    usageHistory,
  };

  // Always-on usage sampler: record the current reading shortly after start and
  // every 30s after, so history accrues whether or not anyone is viewing the
  // Usage tab. Both timers are unref'd (never keep the process alive) and the
  // first sample is deferred so short-lived runs don't write a stray file.
  const recordUsage = () =>
    void buildUsageInfo(cwd)
      .then((usage) => usageHistory.record(usage))
      .catch(() => {});
  const usageWarmup = setTimeout(recordUsage, 5_000);
  usageWarmup.unref?.();
  const usageSampler = setInterval(recordUsage, 30_000);
  usageSampler.unref?.();

  return {
    async start() {
      const server = http.createServer((request, response) => {
        void routeRequest(services, request, response);
      });
      const terminalSocketServer = createTerminalSocketServer(terminalManager);
      // When the host process exits (incl. after ProcessManager's signal
      // handlers re-raise), synchronously kill every PTY — important for
      // ssh/docker sessions that hold real connections.
      const disposeTerminalsOnExit = () => terminalManager.disposeAll();
      process.once("exit", disposeTerminalsOnExit);
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
          process.removeListener("exit", disposeTerminalsOnExit);
          terminalManager.disposeAll();
          terminalSocketServer.close();
          clearTimeout(usageWarmup);
          clearInterval(usageSampler);
          metricsStore.stop();
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
        terminalManager.touch(id); // client activity resets the idle timer
        handleTerminalSocketMessage(session, data);
      } catch {
        sendTerminalMessage(socket, {
          error: "Invalid terminal socket message.",
          type: "error",
        });
      }
    });
    socket.on("close", () => {
      // Leave the PTY running so the tab survives reloads; only drop listeners
      // and tell the manager this client is gone (it persists the session for
      // reattach and lets the idle timer reap it if it's truly abandoned).
      outputSubscription.dispose();
      stateSubscription.dispose();
      terminalManager.detach(id);
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
