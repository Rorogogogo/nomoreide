import { dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import type { ConfigStore } from "../../core/config-store.js";
import {
  browseDirectory,
  type ConfigFileInfo,
  ConfigFilePathError,
  detectConfigFiles,
  resolveConfigFile,
  validateJson,
} from "../../core/config-files.js";
import {
  entriesFromLines,
  looksSecret,
  mergeEntries,
  readEnvFile,
  writeEnvFile,
  type EnvEntry,
} from "../../core/env-file.js";
import { PortConflictError } from "../../core/process-manager.js";
import { readLogSource } from "../../core/log-sources.js";
import { deriveServiceLogSource } from "../../core/service-log-source.js";
import { testServiceCommand } from "../service-tester.js";
import { parseLogQuery } from "./log-sources-routes.js";
import {
  optionalFormValue,
  readForm,
  requiredFormValue,
  sendJson,
} from "../http-utils.js";
import { errorMessage, patternRoute, route, type Route } from "./context.js";

/** Services, bundles, per-service config files, and the HTTP inspector toggle. */
export const serviceRoutes: Route[] = [
  route("POST", "/api/services", async ({ request, response, configStore }) => {
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
  }),

  route("POST", "/api/services/test", async ({ request, response }) => {
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
  }),

  patternRoute(
    /^\/api\/services\/([^/]+)\/test$/,
    ["name"],
    async ({ request, response, params, testRunner }) => {
      if (request.method !== "POST") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const form = await readForm(request);
      try {
        const run = await testRunner.run(params.name, optionalFormValue(form, "pattern"));
        sendJson(response, { ok: true, run });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 409);
      }
    },
  ),

  patternRoute(
    /^\/api\/services\/([^/]+)\/test\/stream$/,
    ["name"],
    ({ request, response, params, testRunner }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      response.write(`retry: 2000\n\n`);
      const current = testRunner.current(params.name);
      if (current) {
        const seed = JSON.stringify({ type: "status", run: current });
        response.write(`event: status\ndata: ${seed}\n\n`);
      }
      const heartbeat = setInterval(() => response.write(`: ping\n\n`), 15000);
      const unsubscribe = testRunner.subscribe(params.name, (event) => {
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      });
      request.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    },
  ),

  route("POST", "/api/bundles", async ({ request, response, configStore }) => {
    const form = await readForm(request);
    // Services may be empty — e.g. dragging the last member out of a group.
    const services = (optionalFormValue(form, "services") ?? "")
      .split(",")
      .map((service) => service.trim())
      .filter(Boolean);
    const config = await configStore.registerBundle(
      { name: requiredFormValue(form, "name"), services },
      optionalFormValue(form, "originalName"),
    );
    sendJson(response, { ok: true, config });
  }),

  patternRoute(
    /^\/api\/services\/([^/]+)\/config-files$/,
    ["name"],
    async ({ request, response, configStore, params }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const name = decodeURIComponent(params.name);
      const serviceCwd = await getServiceCwd(configStore, name);
      if (!serviceCwd) {
        sendJson(response, { ok: false, error: `Service "${name}" has no working directory.` }, 400);
        return;
      }
      const files = await detectConfigFiles(serviceCwd);
      sendJson(response, { ok: true, cwd: serviceCwd, files });
    },
  ),

  patternRoute(
    /^\/api\/services\/([^/]+)\/config-browse$/,
    ["name"],
    async ({ request, response, url, configStore, params }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const name = decodeURIComponent(params.name);
      const serviceCwd = await getServiceCwd(configStore, name);
      if (!serviceCwd) {
        sendJson(response, { ok: false, error: `Service "${name}" has no working directory.` }, 400);
        return;
      }
      try {
        const result = await browseDirectory(serviceCwd, url.searchParams.get("path")?.trim() || undefined);
        sendJson(response, { ok: true, ...result });
      } catch (error) {
        sendJson(
          response,
          { ok: false, error: errorMessage(error) },
          error instanceof ConfigFilePathError ? 400 : 500,
        );
      }
    },
  ),

  patternRoute(
    /^\/api\/services\/([^/]+)\/config-file$/,
    ["name"],
    async ({ request, response, url, configStore, params }) => {
      const name = decodeURIComponent(params.name);
      const serviceCwd = await getServiceCwd(configStore, name);
      if (!serviceCwd) {
        sendJson(response, { ok: false, error: `Service "${name}" has no working directory.` }, 400);
        return;
      }
      const requested = url.searchParams.get("path")?.trim();
      if (!requested) {
        sendJson(response, { ok: false, error: "path is required" }, 400);
        return;
      }
      let file: ConfigFileInfo;
      try {
        file = resolveConfigFile(serviceCwd, requested);
      } catch (error) {
        sendJson(
          response,
          { ok: false, error: errorMessage(error) },
          error instanceof ConfigFilePathError ? 400 : 500,
        );
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
            sendJson(response, { ok: false, error: errorMessage(error) }, 400);
            return;
          }
        }
        await mkdir(dirname(file.path), { recursive: true });
        await writeFile(file.path, content);
        sendJson(response, { ok: true, exists: true, format: file.format, path: file.path, relativePath: file.relativePath, content });
        return;
      }

      sendJson(response, { ok: false, error: "Method not allowed" }, 405);
    },
  ),

  patternRoute(
    /^\/api\/services\/([^/]+)\/inspector$/,
    ["name"],
    async ({ request, response, manager, params }) => {
      if (request.method !== "POST") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const name = decodeURIComponent(params.name);
      const form = await readForm(request);
      const enabled = form.get("enabled") === "true" || form.get("enabled") === "1";
      const status = await manager.setInspectorEnabled(name, enabled);
      sendJson(response, { ok: true, status });
    },
  ),

  patternRoute(
    /^\/api\/services\/([^/]+)\/(start|stop|restart|logs)$/,
    ["name", "action"],
    async ({ request, response, manager, logStore, params, url, configStore }) => {
      const name = decodeURIComponent(params.name);
      const action = params.action;

      if (request.method === "GET" && action === "logs") {
        const query = parseLogQuery(url.searchParams);
        const hasQuery = Boolean(
          query.since || query.until || query.grep || query.level || query.before || query.cursor,
        );
        // SSH journald/docker services can re-query the host for full history;
        // derive that backend from the service's own command.
        const config = await configStore.load();
        const service = config.services.find((item) => item.name === name);
        const source = service ? deriveServiceLogSource(service) : null;

        if (hasQuery && source) {
          try {
            const logs = await readLogSource(source, query);
            sendJson(response, { ok: true, logs, queryable: true });
          } catch (error) {
            sendJson(response, { ok: false, error: errorMessage(error), queryable: true }, 200);
          }
          return;
        }
        // No active query (or not queryable): serve the live buffer.
        const lines = query.lines && query.lines > 0 ? query.lines : 500;
        sendJson(response, { ok: true, logs: logStore.read(name, lines), queryable: Boolean(source) });
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
              conflict: { code: error.code, port: error.port, holder: error.holder },
            },
            409,
          );
          return;
        }
        throw error;
      }
    },
  ),

  patternRoute(
    /^\/api\/bundles\/([^/]+)\/(start|stop|restart)$/,
    ["name", "action"],
    async ({ request, response, manager, params }) => {
      if (request.method !== "POST") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const name = decodeURIComponent(params.name);
      const action = params.action;
      const statuses =
        action === "start"
          ? await manager.startBundle(name)
          : action === "stop"
            ? await manager.stopBundle(name)
            : await manager.restartBundle(name);
      sendJson(response, { ok: true, statuses });
    },
  ),

  // Single-segment service path; registered last so exact routes like
  // `/api/services/test` win first. Only DELETE is handled here.
  patternRoute(
    /^\/api\/services\/([^/]+)$/,
    ["name"],
    async ({ request, response, manager, configStore, params }) => {
      if (request.method !== "DELETE") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const name = decodeURIComponent(params.name);
      const state = manager.status().services[name]?.state;
      if (state === "running" || state === "starting") {
        sendJson(response, { ok: false, error: `Stop "${name}" before deleting it.` }, 409);
        return;
      }
      try {
        const config = await configStore.removeService(name);
        sendJson(response, { ok: true, config });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      }
    },
  ),
];

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
