import { sendJson } from "../http-utils.js";
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

  route("POST", "/api/terminal/sessions", ({ response, terminalManager }) => {
    const session = terminalManager.create();
    sendJson(response, { ok: true, session }, 201);
  }),

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
