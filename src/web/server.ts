import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigStore, ConfigValidationError } from "../core/config-store.js";
import { GitManager, type GitStatus } from "../core/git-manager.js";
import { LogStore } from "../core/log-store.js";
import { isPortAvailable } from "../core/port-utils.js";
import { ProcessManager } from "../core/process-manager.js";
import type { NoMoreIdeConfig, ServiceStatus } from "../core/types.js";

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

async function buildDashboardPayload(options: {
  configStore: ConfigStore;
  cwd: string;
  logStore: LogStore;
  manager: ProcessManager;
}) {
  const config = await options.configStore.load();
  const firstService = config.services[0]?.name;
  const selectedGitRepository = getSelectedGitRepository(config);
  const gitCwd = selectedGitRepository?.path ?? options.cwd;
  const runtime = options.manager.status();
  const [gitStatus, branches, ports] = await Promise.all([
    readGitStatus(gitCwd),
    readGitBranches(gitCwd),
    buildPortOverview(config, runtime.services),
  ]);

  return {
    ok: true,
    cwd: options.cwd,
    config,
    runtime,
    ports,
    logs: firstService ? options.logStore.read(firstService, 80) : [],
    git: {
      cwd: gitCwd,
      selectedRepository: selectedGitRepository ?? null,
      status: gitStatus ?? null,
      branches: branches ?? [],
      error: gitStatus ? undefined : `Not a Git repository: ${gitCwd}`,
    },
  };
}

interface PortOverview {
  port: number;
  available: boolean;
  state: "available" | "managed" | "occupied";
  services: string[];
  urls: string[];
}

async function buildPortOverview(
  config: NoMoreIdeConfig,
  runtimeServices: Record<string, ServiceStatus>,
): Promise<PortOverview[]> {
  const ports = new Map<number, { services: Set<string>; urls: Set<string> }>();

  for (const service of config.services) {
    if (service.port) {
      const entry = getPortEntry(ports, service.port);
      entry.services.add(service.name);
    }
  }

  for (const status of Object.values(runtimeServices)) {
    if (!status.url) continue;
    const port = portFromUrl(status.url);
    if (!port) continue;
    const entry = getPortEntry(ports, port);
    entry.services.add(status.name);
    entry.urls.add(status.url);
  }

  return Promise.all(
    [...ports.entries()]
      .sort(([left], [right]) => left - right)
      .map(async ([port, entry]) => {
        const available = await isPortAvailable(port);
        const managed = [...entry.services].some((serviceName) => {
          const status = runtimeServices[serviceName];
          const urlPort = portFromUrl(status?.url);
          return (
            status?.state === "running" &&
            (urlPort === port ||
              (urlPort === undefined &&
                config.services.some(
                  (service) => service.name === serviceName && service.port === port,
                )))
          );
        });

        return {
          port,
          available,
          state: managed ? "managed" : available ? "available" : "occupied",
          services: [...entry.services].sort(),
          urls: [...entry.urls].sort(),
        };
      }),
  );
}

function getPortEntry(
  ports: Map<number, { services: Set<string>; urls: Set<string> }>,
  port: number,
) {
  let entry = ports.get(port);
  if (!entry) {
    entry = { services: new Set<string>(), urls: new Set<string>() };
    ports.set(port, entry);
  }
  return entry;
}

function portFromUrl(url: string | undefined): number | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.port ? Number(parsed.port) : undefined;
  } catch {
    return undefined;
  }
}

async function readWebAppShell(): Promise<string> {
  for (const path of webAppShellCandidates()) {
    try {
      return await readFile(path, "utf8");
    } catch {
      // Try the next candidate; source index keeps tests and dev fallback readable.
    }
  }

  throw new Error("React web app shell was not found. Run npm run build.");
}

async function sendStaticAsset(
  response: ServerResponse,
  requestPath: string,
): Promise<boolean> {
  const relativePath = requestPath.replace(/^\/+/, "");
  for (const root of webAssetRoots()) {
    const assetPath = resolve(root, relativePath);
    if (!assetPath.startsWith(root)) {
      continue;
    }

    try {
      const asset = await readFile(assetPath);
      response.writeHead(200, {
        "content-type": contentTypeFor(assetPath),
      });
      response.end(asset);
      return true;
    } catch {
      // Try the next asset root.
    }
  }

  return false;
}

function webAppShellCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    resolve(here, "../../dist/web/client/index.html"),
    resolve(here, "client/index.html"),
    resolve(here, "../../src/web/client/index.html"),
  ];
}

function webAssetRoots(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    resolve(here, "client"),
    resolve(here, "../../dist/web/client"),
  ];
}

function contentTypeFor(path: string): string {
  switch (extname(path)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function getSelectedGitRepository(
  config: Awaited<ReturnType<ConfigStore["load"]>>,
) {
  return (
    config.gitRepositories.find(
      (repository) => repository.name === config.selectedGitRepository,
    ) ?? config.gitRepositories[0]
  );
}

async function readGitStatus(cwd: string): Promise<GitStatus | undefined> {
  try {
    return await new GitManager(cwd).status();
  } catch {
    return undefined;
  }
}

async function readGitBranches(cwd: string) {
  try {
    return await new GitManager(cwd).branches();
  } catch {
    return undefined;
  }
}

async function readGitDiff(cwd: string, path: string): Promise<string | undefined> {
  try {
    return await new GitManager(cwd).diff(path);
  } catch {
    return undefined;
  }
}

async function selectedGitCwd(configStore: ConfigStore, fallbackCwd: string): Promise<string> {
  const config = await configStore.load();
  return getSelectedGitRepository(config)?.path ?? fallbackCwd;
}

async function listDirectories(path: string) {
  const resolvedPath = resolve(path);
  const entries = await readdir(resolvedPath, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory() && !ignoredDirectoryNames.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      path: resolve(resolvedPath, entry.name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    ok: true,
    path: resolvedPath,
    parent: dirname(resolvedPath),
    entries: directories,
  };
}

const ignoredDirectoryNames = new Set([".git", "node_modules"]);

function sendHtml(response: ServerResponse, html: string, status = 200): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
  });
  response.end(html);
}

function sendText(response: ServerResponse, text: string, status = 200): void {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
  });
  response.end(text);
}

function sendHead(response: ServerResponse, contentType: string, status = 200): void {
  response.writeHead(status, {
    "content-type": contentType,
  });
  response.end();
}

function sendJson(response: ServerResponse, data: unknown, status = 200): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(data));
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function requiredFormValue(form: URLSearchParams, key: string): string {
  const value = form.get(key)?.trim();
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function optionalFormValue(
  form: URLSearchParams,
  key: string,
): string | undefined {
  const value = form.get(key)?.trim();
  return value || undefined;
}
