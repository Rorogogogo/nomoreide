import { resolveServiceTerminal } from "../../core/terminal-spawn.js";
import { readJson, sendJson } from "../http-utils.js";
import { patternRoute, route, type Route } from "./context.js";

/**
 * Terminal tab session management. The PTY data stream stays on the
 * `/api/terminal/socket` WebSocket (handled in `server.ts`); these endpoints
 * only let the client list tabs on reload, open a new tab, and close one.
 */
export const terminalRoutes: Route[] = [
  route("GET", "/api/terminal/sessions", ({ response, terminalManager }) => {
    sendJson(response, { ok: true, sessions: terminalManager.list() });
  }),

  route(
    "POST",
    "/api/terminal/sessions",
    async ({ request, response, terminalManager, configStore }) => {
      const body = await readJson(request);
      const serviceName =
        typeof body.serviceName === "string" ? body.serviceName.trim() : "";

      // No service named → a plain workspace shell (the `+` tab behavior).
      if (!serviceName) {
        const session = terminalManager.create();
        sendJson(response, { ok: true, session }, 201);
        return;
      }

      // The client only names a registered service; the server derives the
      // command (shell / ssh / docker exec) so this endpoint can't be coerced
      // into running an arbitrary program.
      const config = await configStore.load();
      const service = config.services.find((item) => item.name === serviceName);
      if (!service) {
        sendJson(response, { ok: false, error: `Unknown service: ${serviceName}` }, 404);
        return;
      }

      const resolved = resolveServiceTerminal(service);
      if (!resolved.ok) {
        sendJson(response, { ok: false, error: resolved.error }, 400);
        return;
      }

      // Stable id per service so reopening the tab reattaches to the same
      // shell instead of spawning a duplicate.
      const session = terminalManager.createWithId(
        `svc:${service.name}`,
        resolved.options,
      );
      sendJson(response, { ok: true, session }, 201);
    },
  ),

  patternRoute(
    /^\/api\/terminal\/sessions\/([^/]+)$/,
    ["id"],
    ({ request, response, params, terminalManager }) => {
      if (request.method !== "DELETE") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const closed = terminalManager.close(decodeURIComponent(params.id));
      sendJson(response, { ok: closed, sessions: terminalManager.list() });
    },
  ),
];
