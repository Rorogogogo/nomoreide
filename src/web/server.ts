import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import {
  ConfigStore,
  ConfigValidationError,
  defaultGlobalConfigPath,
} from "../core/config-store.js";
import { GitManager } from "../core/git-manager.js";
import { LogStore } from "../core/log-store.js";
import { PortConflictError, ProcessManager } from "../core/process-manager.js";
import { TimelineStore } from "../core/timeline-store.js";
import { ToolCallStore } from "../core/tool-call-store.js";
import { testServiceCommand } from "./service-tester.js";
import {
  buildDashboardPayload,
  getSelectedGitRepository,
  readGitDiff,
  selectedGitCwd,
} from "./dashboard.js";
import { buildAgentInfo } from "./agent-info.js";
import { buildUsageInfo } from "./usage-info.js";
import { listDirectories } from "./directories.js";
import {
  optionalFormValue,
  readForm,
  requiredFormValue,
  sendHead,
  sendHtml,
  sendJson,
  sendText,
} from "./http-utils.js";
import { readWebAppShell, sendStaticAsset } from "./static-assets.js";

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

  return {
    async start() {
      const server = http.createServer((request, response) => {
        void routeRequest({
          request,
          response,
          configStore,
          logStore,
          manager,
          timelineStore,
          cwd,
          toolCallStore,
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

async function routeRequest(options: {
  request: IncomingMessage;
  response: ServerResponse;
  configStore: ConfigStore;
  cwd: string;
  logStore: LogStore;
  manager: ProcessManager;
  timelineStore: TimelineStore;
  toolCallStore: ToolCallStore;
}): Promise<void> {
  const {
    request,
    response,
    configStore,
    cwd,
    logStore,
    manager,
    timelineStore,
    toolCallStore,
  } = options;
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  try {
    if (request.method === "HEAD" && (url.pathname === "/" || url.pathname === "/git")) {
      sendHead(response, "text/html; charset=utf-8");
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/dashboard") {
      sendJson(
        response,
        await buildDashboardPayload({
          configStore,
          cwd,
          logStore,
          manager,
          timelineStore,
        }),
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, { ok: true, app: "nomoreide" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/agent") {
      sendJson(response, { ok: true, agent: await buildAgentInfo(cwd) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/agent/usage") {
      sendJson(response, { ok: true, usage: await buildUsageInfo(cwd) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/agent/tool-calls") {
      const limitParam = Number(url.searchParams.get("limit"));
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : 100;
      sendJson(response, { ok: true, records: toolCallStore.recent(limit) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/agent/tool-calls/stream") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      response.write(`retry: 2000\n\n`);
      for (const record of toolCallStore.recent(50)) {
        response.write(`event: tool-call\ndata: ${JSON.stringify(record)}\n\n`);
      }
      const heartbeat = setInterval(() => {
        response.write(`: ping\n\n`);
      }, 15000);
      const unsubscribe = toolCallStore.subscribe((record) => {
        response.write(`event: tool-call\ndata: ${JSON.stringify(record)}\n\n`);
      });
      request.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/fs/directories") {
      sendJson(
        response,
        await listDirectories(url.searchParams.get("path")?.trim() || cwd),
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/git/diff") {
      const config = await configStore.load();
      const selectedGitRepository = getSelectedGitRepository(config);
      const gitCwd = selectedGitRepository?.path ?? cwd;
      const selectedFile = url.searchParams.get("file")?.trim();
      if (!selectedFile) {
        sendJson(response, { ok: false, error: "file is required" }, 400);
        return;
      }
      const git = new GitManager(gitCwd);
      const status = await git.status();
      const selectedStatus = status.files.find((file) => file.path === selectedFile);
      const diff = selectedStatus
        ? await git.fileDiff(selectedStatus)
        : await readGitDiff(gitCwd, selectedFile);
      if (diff === undefined) {
        sendJson(response, { ok: false, error: "No changes or file not found." }, 404);
        return;
      }
      sendText(response, diff);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/fetch") {
      const gitCwd = await selectedGitCwd(configStore, cwd);
      const output = await new GitManager(gitCwd).fetch();
      sendJson(response, { ok: true, output });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/branches") {
      const form = await readForm(request);
      const gitCwd = await selectedGitCwd(configStore, cwd);
      const output = await new GitManager(gitCwd).createBranch(
        requiredFormValue(form, "name"),
      );
      sendJson(response, { ok: true, output });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/branches/switch") {
      const form = await readForm(request);
      const gitCwd = await selectedGitCwd(configStore, cwd);
      const output = await new GitManager(gitCwd).switchBranch(
        requiredFormValue(form, "name"),
      );
      sendJson(response, { ok: true, output });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      sendJson(response, { ok: true, status: manager.status() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/services") {
      const form = await readForm(request);
      const portValue = form.get("port")?.trim();
      const port = portValue ? Number(portValue) : undefined;
      const kind = (optionalFormValue(form, "kind") ?? "local") as
        | "local"
        | "docker-compose"
        | "ssh";
      const name = requiredFormValue(form, "name");
      const description = optionalFormValue(form, "description");

      const definition =
        kind === "docker-compose"
          ? {
              name,
              kind: "docker-compose" as const,
              cwd: requiredFormValue(form, "cwd"),
              composeFile: optionalFormValue(form, "composeFile"),
              composeService: requiredFormValue(form, "composeService"),
              port,
              description,
            }
          : kind === "ssh"
            ? {
                name,
                kind: "ssh" as const,
                host: requiredFormValue(form, "host"),
                cwd: requiredFormValue(form, "cwd"),
                command: requiredFormValue(form, "command"),
                port,
                description,
              }
            : {
                name,
                command: requiredFormValue(form, "command"),
                cwd: requiredFormValue(form, "cwd"),
                port,
                description,
              };

      const config = await configStore.registerService(definition);
      sendJson(response, { ok: true, config });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/services/test") {
      const form = await readForm(request);
      const portValue = form.get("port")?.trim();
      sendJson(
        response,
        await testServiceCommand({
          command: requiredFormValue(form, "command"),
          cwd: requiredFormValue(form, "cwd"),
          port: portValue ? Number(portValue) : undefined,
        }),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/bundles") {
      const form = await readForm(request);
      const services = requiredFormValue(form, "services")
        .split(",")
        .map((service) => service.trim())
        .filter(Boolean);
      const config = await configStore.registerBundle({
        name: requiredFormValue(form, "name"),
        services,
      }, optionalFormValue(form, "originalName"));
      sendJson(response, { ok: true, config });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/repositories") {
      const form = await readForm(request);
      const config = await configStore.registerGitRepository({
        name: requiredFormValue(form, "name"),
        path: requiredFormValue(form, "path"),
      });
      sendJson(response, { ok: true, config });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/select") {
      const form = await readForm(request);
      const config = await configStore.selectGitRepository(
        requiredFormValue(form, "name"),
      );
      sendJson(response, { ok: true, config });
      return;
    }

    const inspectorMatch = url.pathname.match(
      /^\/api\/services\/([^/]+)\/inspector$/,
    );
    if (inspectorMatch) {
      if (request.method !== "POST") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const name = decodeURIComponent(inspectorMatch[1]);
      const form = await readForm(request);
      const enabled = form.get("enabled") === "true" || form.get("enabled") === "1";
      const status = await manager.setInspectorEnabled(name, enabled);
      sendJson(response, { ok: true, status });
      return;
    }

    const serviceMatch = url.pathname.match(
      /^\/api\/services\/([^/]+)\/(start|stop|restart|logs)$/,
    );
    if (serviceMatch) {
      const [, encodedName, action] = serviceMatch;
      const name = decodeURIComponent(encodedName);

      if (request.method === "GET" && action === "logs") {
        sendJson(response, { ok: true, logs: logStore.read(name, 200) });
        return;
      }

      if (request.method !== "POST") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }

      try {
        let startOptions: { killHolder?: boolean } = {};
        if (action === "start" || action === "restart") {
          const form = await readForm(request).catch(() => new URLSearchParams());
          if (form.get("strategy") === "killHolder") {
            startOptions = { killHolder: true };
          }
        }
        const status =
          action === "start"
            ? await manager.startService(name, startOptions)
            : action === "stop"
              ? await manager.stopService(name)
              : await manager.restartService(name, startOptions);
        sendJson(response, { ok: true, status });
      } catch (error) {
        if (error instanceof PortConflictError) {
          sendJson(
            response,
            {
              ok: false,
              error: error.message,
              conflict: {
                code: error.code,
                port: error.port,
                holder: error.holder,
              },
            },
            409,
          );
          return;
        }
        throw error;
      }
      return;
    }

    const bundleMatch = url.pathname.match(
      /^\/api\/bundles\/([^/]+)\/(start|stop|restart)$/,
    );
    if (bundleMatch) {
      if (request.method !== "POST") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }

      const [, encodedName, action] = bundleMatch;
      const name = decodeURIComponent(encodedName);
      const statuses =
        action === "start"
          ? await manager.startBundle(name)
          : action === "stop"
            ? await manager.stopBundle(name)
            : await manager.restartBundle(name);
      sendJson(response, { ok: true, statuses });
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/assets/")) {
      if (await sendStaticAsset(response, url.pathname)) {
        return;
      }
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/git")) {
      sendHtml(response, await readWebAppShell());
      return;
    }

    sendHtml(response, "Not found", 404);
  } catch (error) {
    sendJson(
      response,
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      error instanceof ConfigValidationError ? 400 : 500,
    );
  }
}

function timelineBaseDir(logDir: string | undefined): string {
  return logDir ? dirname(resolve(logDir)) : resolve(process.cwd(), ".nomoreide");
}
