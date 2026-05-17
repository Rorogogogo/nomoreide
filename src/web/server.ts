import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { ConfigStore, ConfigValidationError } from "../core/config-store.js";
import { GitManager } from "../core/git-manager.js";
import { LogStore } from "../core/log-store.js";
import { ProcessManager } from "../core/process-manager.js";
import { testServiceCommand } from "./service-tester.js";
import {
  buildDashboardPayload,
  getSelectedGitRepository,
  readGitDiff,
  selectedGitCwd,
} from "./dashboard.js";
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
    options.configPath ?? resolve(process.cwd(), "nomoreide.config.json"),
  );
  const logStore = new LogStore({
    baseDir: options.logDir ?? resolve(process.cwd(), ".nomoreide/logs"),
  });
  const manager = new ProcessManager({ configStore, logStore });
  const cwd = options.cwd ?? process.cwd();

  return {
    async start() {
      const server = http.createServer((request, response) => {
        void routeRequest({
          request,
          response,
          configStore,
          logStore,
          manager,
          cwd,
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
}): Promise<void> {
  const { request, response, configStore, cwd, logStore, manager } = options;
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  try {
    if (request.method === "HEAD" && (url.pathname === "/" || url.pathname === "/git")) {
      sendHead(response, "text/html; charset=utf-8");
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/dashboard") {
      sendJson(
        response,
        await buildDashboardPayload({ configStore, cwd, logStore, manager }),
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, { ok: true, app: "nomoreide" });
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
      const config = await configStore.registerService({
        name: requiredFormValue(form, "name"),
        command: requiredFormValue(form, "command"),
        cwd: requiredFormValue(form, "cwd"),
        port: portValue ? Number(portValue) : undefined,
        description: optionalFormValue(form, "description"),
      });
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

      const status =
        action === "start"
          ? await manager.startService(name)
          : action === "stop"
            ? await manager.stopService(name)
            : await manager.restartService(name);
      sendJson(response, { ok: true, status });
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
