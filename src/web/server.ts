import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import {
  ConfigStore,
  ConfigValidationError,
  defaultGlobalConfigPath,
} from "../core/config-store.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { GitManager } from "../core/git-manager.js";
import {
  browseDirectory,
  ConfigFilePathError,
  detectConfigFiles,
  resolveConfigFile,
  validateJson,
} from "../core/config-files.js";
import {
  entriesFromLines,
  looksSecret,
  mergeEntries,
  readEnvFile,
  writeEnvFile,
  type EnvEntry,
} from "../core/env-file.js";
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
    if (
      request.method === "HEAD" &&
      (url.pathname === "/" || url.pathname === "/git" || url.pathname === "/agent")
    ) {
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

    if (request.method === "GET" && url.pathname === "/api/git/files") {
      const gitCwd = await selectedGitCwd(configStore, cwd);
      try {
        const files = await new GitManager(gitCwd).listTrackedFiles();
        sendJson(response, { ok: true, files });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, { ok: false, error: message }, 400);
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/git/file") {
      const gitCwd = await selectedGitCwd(configStore, cwd);
      const path = url.searchParams.get("path")?.trim();
      if (!path) {
        sendJson(response, { ok: false, error: "path is required" }, 400);
        return;
      }
      try {
        const file = await new GitManager(gitCwd).readTrackedFile(path);
        sendJson(response, { ok: true, ...file });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, { ok: false, error: message }, 404);
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/git/commit") {
      const gitCwd = await selectedGitCwd(configStore, cwd);
      const hash = url.searchParams.get("hash")?.trim();
      const file = url.searchParams.get("file")?.trim() || undefined;
      if (!hash) {
        sendJson(response, { ok: false, error: "hash is required" }, 400);
        return;
      }
      try {
        const diff = await new GitManager(gitCwd).commitDiff(hash, file);
        sendText(response, diff);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, { ok: false, error: message }, 400);
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/git/commit/files") {
      const gitCwd = await selectedGitCwd(configStore, cwd);
      const hash = url.searchParams.get("hash")?.trim();
      if (!hash) {
        sendJson(response, { ok: false, error: "hash is required" }, 400);
        return;
      }
      try {
        const files = await new GitManager(gitCwd).commitFiles(hash);
        sendJson(response, { ok: true, files });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, { ok: false, error: message }, 400);
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/git/graph") {
      const gitCwd = await selectedGitCwd(configStore, cwd);
      const limitParam = url.searchParams.get("limit")?.trim();
      const parsedLimit = limitParam ? Number(limitParam) : 200;
      const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(Math.floor(parsedLimit), 2000)
        : 200;
      const commits = await new GitManager(gitCwd).graph(limit);
      sendJson(response, { ok: true, commits });
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

    const configFilesMatch = url.pathname.match(
      /^\/api\/services\/([^/]+)\/config-files$/,
    );
    if (configFilesMatch) {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const name = decodeURIComponent(configFilesMatch[1]);
      const serviceCwd = await getServiceCwd(configStore, name);
      if (!serviceCwd) {
        sendJson(
          response,
          { ok: false, error: `Service "${name}" has no working directory.` },
          400,
        );
        return;
      }
      const files = await detectConfigFiles(serviceCwd);
      sendJson(response, { ok: true, cwd: serviceCwd, files });
      return;
    }

    const browseMatch = url.pathname.match(
      /^\/api\/services\/([^/]+)\/config-browse$/,
    );
    if (browseMatch) {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const name = decodeURIComponent(browseMatch[1]);
      const serviceCwd = await getServiceCwd(configStore, name);
      if (!serviceCwd) {
        sendJson(
          response,
          { ok: false, error: `Service "${name}" has no working directory.` },
          400,
        );
        return;
      }
      try {
        const result = await browseDirectory(serviceCwd, url.searchParams.get("path")?.trim() || undefined);
        sendJson(response, { ok: true, ...result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, { ok: false, error: message }, error instanceof ConfigFilePathError ? 400 : 500);
      }
      return;
    }

    const configFileMatch = url.pathname.match(
      /^\/api\/services\/([^/]+)\/config-file$/,
    );
    if (configFileMatch) {
      const name = decodeURIComponent(configFileMatch[1]);
      const serviceCwd = await getServiceCwd(configStore, name);
      if (!serviceCwd) {
        sendJson(
          response,
          { ok: false, error: `Service "${name}" has no working directory.` },
          400,
        );
        return;
      }
      const requested = url.searchParams.get("path")?.trim();
      if (!requested) {
        sendJson(response, { ok: false, error: "path is required" }, 400);
        return;
      }
      let file;
      try {
        file = resolveConfigFile(serviceCwd, requested);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, { ok: false, error: message }, error instanceof ConfigFilePathError ? 400 : 500);
        return;
      }

      if (request.method === "GET") {
        if (file.format === "env") {
          const { exists, lines } = await readEnvFile(file.path);
          const entries = entriesFromLines(lines).map((entry) => ({
            key: entry.key,
            value: entry.value,
            secret: looksSecret(entry.key),
          }));
          sendJson(response, { ok: true, exists, format: file.format, path: file.path, relativePath: file.relativePath, entries });
          return;
        }
        const { content, exists } = await readTextFile(file.path);
        sendJson(response, { ok: true, exists, format: file.format, path: file.path, relativePath: file.relativePath, content });
        return;
      }

      if (request.method === "PUT") {
        const body = await readJsonBody(request);
        if (file.format === "env") {
          const parsed = parseEnvEntries(body);
          const { lines } = await readEnvFile(file.path);
          const merged = mergeEntries(lines, parsed);
          await writeEnvFile(file.path, merged);
          const entries = entriesFromLines(merged).map((entry) => ({
            key: entry.key,
            value: entry.value,
            secret: looksSecret(entry.key),
          }));
          sendJson(response, { ok: true, exists: true, format: file.format, path: file.path, relativePath: file.relativePath, entries });
          return;
        }
        const content = (body as { content?: unknown })?.content;
        if (typeof content !== "string") {
          sendJson(response, { ok: false, error: "content must be a string" }, 400);
          return;
        }
        if (file.format === "json") {
          try {
            validateJson(content);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendJson(response, { ok: false, error: message }, 400);
            return;
          }
        }
        await mkdir(dirname(file.path), { recursive: true });
        await writeFile(file.path, content);
        sendJson(response, { ok: true, exists: true, format: file.format, path: file.path, relativePath: file.relativePath, content });
        return;
      }

      sendJson(response, { ok: false, error: "Method not allowed" }, 405);
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

    if (
      request.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/git" || url.pathname === "/agent")
    ) {
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

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function parseEnvEntries(body: unknown): EnvEntry[] {
  if (!body || typeof body !== "object") {
    throw new Error("entries array is required.");
  }
  const raw = (body as { entries?: unknown }).entries;
  if (!Array.isArray(raw)) {
    throw new Error("entries must be an array.");
  }
  const seen = new Set<string>();
  const result: EnvEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      throw new Error("each entry must be { key, value }.");
    }
    const { key, value } = item as { key?: unknown; value?: unknown };
    if (typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) {
      throw new Error(`invalid env key: ${JSON.stringify(key)}`);
    }
    if (typeof value !== "string") {
      throw new Error(`value for "${key}" must be a string.`);
    }
    if (seen.has(key)) {
      throw new Error(`duplicate env key: ${key}`);
    }
    seen.add(key);
    result.push({ key, value });
  }
  return result;
}

async function getServiceCwd(configStore: ConfigStore, name: string): Promise<string | undefined> {
  const config = await configStore.load();
  const service = config.services.find((item) => item.name === name);
  if (!service) {
    throw new Error(`Service "${name}" not found.`);
  }
  return (service as { cwd?: string }).cwd;
}

async function readTextFile(path: string): Promise<{ content: string; exists: boolean }> {
  try {
    const content = await readFile(path, "utf8");
    return { content, exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { content: "", exists: false };
    }
    throw error;
  }
}

function timelineBaseDir(logDir: string | undefined): string {
  return logDir ? dirname(resolve(logDir)) : resolve(process.cwd(), ".nomoreide");
}
