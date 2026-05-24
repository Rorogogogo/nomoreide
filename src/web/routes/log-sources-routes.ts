import { readLogSource } from "../../core/log-sources.js";
import type { LogDriver, LogQuery, LogSourceDefinition, LogSourceKind } from "../../core/types.js";
import { optionalFormValue, readForm, requiredFormValue, sendJson } from "../http-utils.js";
import { errorMessage, patternRoute, route, type Route } from "./context.js";

const KINDS: LogSourceKind[] = ["file", "ssh", "command"];
const DRIVERS: LogDriver[] = ["journald", "docker"];

function parseKind(value: string): LogSourceKind {
  if (!KINDS.includes(value as LogSourceKind)) {
    throw new Error(`Unsupported log source kind "${value}". Use one of: ${KINDS.join(", ")}.`);
  }
  return value as LogSourceKind;
}

function parseDriver(value: string | undefined): LogDriver | undefined {
  if (!value) return undefined;
  if (!DRIVERS.includes(value as LogDriver)) {
    throw new Error(`Unsupported log driver "${value}". Use one of: ${DRIVERS.join(", ")}.`);
  }
  return value as LogDriver;
}

/** Reads the read-time query (time range, text, level, paging) off the URL. */
export function parseLogQuery(params: URLSearchParams): LogQuery {
  const query: LogQuery = {};
  const since = params.get("since");
  const until = params.get("until");
  const grep = params.get("grep");
  const level = params.get("level");
  const cursor = params.get("cursor");
  const before = params.get("before");
  const lines = Number(params.get("lines"));
  if (since) query.since = since;
  if (until) query.until = until;
  if (grep) query.grep = grep;
  if (level === "warn" || level === "error") query.level = level;
  if (cursor) query.cursor = cursor;
  if (before) query.before = before;
  if (Number.isFinite(lines) && lines > 0) query.lines = lines;
  return query;
}

/** Saved, on-demand log sources (UAT/PROD/…) — file, remote ssh file, or command. */
export const logSourceRoutes: Route[] = [
  route("GET", "/api/log-sources", async ({ response, configStore }) => {
    const config = await configStore.load();
    sendJson(response, { ok: true, sources: config.logSources });
  }),

  route("POST", "/api/log-sources", async ({ request, response, configStore }) => {
    const form = await readForm(request);
    const definition: LogSourceDefinition = {
      name: requiredFormValue(form, "name"),
      kind: parseKind(requiredFormValue(form, "kind")),
      path: optionalFormValue(form, "path"),
      host: optionalFormValue(form, "host"),
      command: optionalFormValue(form, "command"),
      cwd: optionalFormValue(form, "cwd"),
      driver: parseDriver(optionalFormValue(form, "driver")),
      unit: optionalFormValue(form, "unit"),
      container: optionalFormValue(form, "container"),
    };
    try {
      const config = await configStore.registerLogSource(definition);
      sendJson(response, { ok: true, sources: config.logSources });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  patternRoute(
    /^\/api\/log-sources\/([^/]+)$/,
    ["name"],
    async ({ request, response, params, configStore }) => {
      if (request.method !== "DELETE") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const config = await configStore.removeLogSource(decodeURIComponent(params.name));
      sendJson(response, { ok: true, sources: config.logSources });
    },
  ),

  patternRoute(
    /^\/api\/log-sources\/([^/]+)\/logs$/,
    ["name"],
    async ({ request, response, params, url, configStore }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const name = decodeURIComponent(params.name);
      const config = await configStore.load();
      const source = config.logSources.find((item) => item.name === name);
      if (!source) {
        sendJson(response, { ok: false, error: `Unknown log source "${name}".` }, 404);
        return;
      }
      try {
        const logs = await readLogSource(source, parseLogQuery(url.searchParams));
        sendJson(response, { ok: true, logs });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 200);
      }
    },
  ),
];
