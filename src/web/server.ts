import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import {
  ConfigStore,
  ConfigValidationError,
  defaultGlobalConfigPath,
} from "../core/config-store.js";
import { ErrorInbox } from "../core/error-inbox.js";
import { LogStore } from "../core/log-store.js";
import { ProcessManager } from "../core/process-manager.js";
import { ReproBundleBuilder } from "../core/repro-bundle.js";
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
  const testRunner = new TestRunner({ logStore, configStore, cwd });
  const reproBundle = new ReproBundleBuilder({
    errorInbox,
    manager,
    reproDir: resolve(cwd, ".nomoreide/repros"),
  });

  const services: RouteServices = {
    configStore,
    cwd,
    errorInbox,
    logStore,
    manager,
    reproBundle,
    testRunner,
    timelineStore,
    toolCallStore,
  };

  return {
    async start() {
      const server = http.createServer((request, response) => {
        void routeRequest(services, request, response);
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
