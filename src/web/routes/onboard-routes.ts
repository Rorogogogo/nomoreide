import type { ServerResponse } from "node:http";
import {
  cloneRepository,
  defaultReposDir,
  isInsideReposDir,
  proposeDatabases,
  proposeServices,
  runInstall,
  scanRepo,
} from "../../core/repo-onboard.js";
import type { DatabaseConnection, ServiceDefinition } from "../../core/types.js";
import { publicConfig } from "../../core/public-config.js";
import { readJson, sendJson } from "../http-utils.js";
import { errorMessage, route, type Route } from "./context.js";

/**
 * Structured "Add from GitHub" wizard: paste a URL → clone + scan + propose →
 * confirm → install (streamed) → register & start. (The AI-native path skips
 * all this and drives the same core module from the agent dock instead.)
 * Cloning / install live in the guarded `repo-onboard` core module so
 * GitManager stays read-safe.
 */
export const onboardRoutes: Route[] = [
  route("POST", "/api/onboard/scan", async ({ request, response }) => {
    const body = await readJson(request);
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!url) {
      sendJson(response, { ok: false, error: "url is required" }, 400);
      return;
    }
    try {
      const { clonePath } = await cloneRepository(url, defaultReposDir());
      const profile = await scanRepo(clonePath);
      const proposals = proposeServices(profile);
      const databases = proposeDatabases(profile);
      sendJson(response, { ok: true, profile, proposals, databases });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 422);
    }
  }),

  route("POST", "/api/onboard/install/stream", async ({ request, response }) => {
    const body = await readJson(request);
    const clonePath = typeof body.clonePath === "string" ? body.clonePath : "";
    const command = typeof body.command === "string" ? body.command.trim() : "";
    if (!clonePath || !isInsideReposDir(clonePath)) {
      sendJson(response, { ok: false, error: "clonePath must be an onboarded repo" }, 400);
      return;
    }
    if (!command) {
      sendJson(response, { ok: false, error: "command is required" }, 400);
      return;
    }
    openEventStream(response);
    const heartbeat = setInterval(() => response.write(`: ping\n\n`), 15000);
    request.on("close", () => clearInterval(heartbeat));
    try {
      const result = await runInstall({
        cwd: clonePath,
        command,
        onLine: (line) =>
          response.write(`event: output\ndata: ${JSON.stringify(line)}\n\n`),
      });
      response.write(`event: done\ndata: ${JSON.stringify(result)}\n\n`);
    } catch (error) {
      response.write(
        `event: error\ndata: ${JSON.stringify({ error: errorMessage(error) })}\n\n`,
      );
    } finally {
      clearInterval(heartbeat);
      response.end();
    }
  }),

  route("POST", "/api/onboard/register", async ({ request, response, configStore, manager }) => {
    const body = await readJson(request);
    if (
      typeof body.name !== "string" ||
      typeof body.cwd !== "string" ||
      !isInsideReposDir(body.cwd)
    ) {
      sendJson(response, { ok: false, error: "name and an onboarded cwd are required" }, 400);
      return;
    }
    try {
      const definition = toServiceDefinition(body);
      const config = await configStore.registerService(definition);
      // Best-effort: surface the clone in the Git tab too.
      await configStore
        .registerGitRepository({ name: definition.name, path: String(body.cwd) })
        .catch(() => undefined);
      // Best-effort: register an accompanying database connection so it shows in
      // the Database tab (e.g. a docker-compose Postgres/MySQL behind the app).
      const database = parseDatabaseInput(body.database);
      if (database) {
        await configStore.registerDatabase(database).catch(() => undefined);
      }
      const started = body.start === true ? await manager.startService(definition.name) : null;
      sendJson(response, { ok: true, config: publicConfig(config), started });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 422);
    }
  }),
];

function openEventStream(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  response.write(`retry: 2000\n\n`);
}

/** Validate an optional database payload that rides along with registration. */
function parseDatabaseInput(value: unknown): DatabaseConnection | undefined {
  if (!value || typeof value !== "object") return undefined;
  const db = value as Record<string, unknown>;
  const engine = db.engine;
  if (
    typeof db.name !== "string" ||
    !db.name.trim() ||
    typeof db.url !== "string" ||
    !db.url.trim() ||
    (engine !== "postgres" && engine !== "mysql" && engine !== "sqlite")
  ) {
    return undefined;
  }
  return { name: db.name.trim(), engine, url: db.url.trim() };
}

/** Map a confirmed onboarding proposal onto a ConfigStore ServiceDefinition. */
function toServiceDefinition(body: Record<string, unknown>): ServiceDefinition {
  const name = String(body.name);
  const cwd = String(body.cwd);
  const port = typeof body.port === "number" ? body.port : undefined;
  const description =
    typeof body.description === "string" && body.description.trim()
      ? body.description.trim()
      : undefined;

  if (body.kind === "docker-compose") {
    if (typeof body.composeService !== "string" || !body.composeService.trim()) {
      throw new Error("composeService is required for a docker-compose service.");
    }
    return {
      name,
      kind: "docker-compose",
      cwd,
      composeFile:
        typeof body.composeFile === "string" && body.composeFile.trim()
          ? body.composeFile.trim()
          : undefined,
      composeService: body.composeService.trim(),
      port,
      description,
    };
  }

  if (typeof body.command !== "string" || !body.command.trim()) {
    throw new Error("command is required for a local service.");
  }
  const env =
    body.env && typeof body.env === "object" && !Array.isArray(body.env)
      ? (body.env as Record<string, string>)
      : undefined;
  return { name, command: body.command.trim(), cwd, port, env, description };
}
