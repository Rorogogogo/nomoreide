import { sendJson } from "../http-utils.js";
import { patternRoute, route, type Route } from "./context.js";

/** Error Inbox: deduped error/stack-trace incidents + copy-to-agent prompts. */
export const errorRoutes: Route[] = [
  route("GET", "/api/errors", ({ response, url, errorInbox }) => {
    const limitParam = Number(url.searchParams.get("limit"));
    const limit =
      Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 100;
    sendJson(response, { ok: true, incidents: errorInbox.list(limit) });
  }),

  route("GET", "/api/errors/stream", ({ request, response, errorInbox }) => {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    response.write(`retry: 2000\n\n`);
    for (const incident of errorInbox.list(50)) {
      response.write(`event: incident\ndata: ${JSON.stringify(incident)}\n\n`);
    }
    const heartbeat = setInterval(() => {
      response.write(`: ping\n\n`);
    }, 15000);
    const unsubscribe = errorInbox.subscribe((incident) => {
      response.write(`event: incident\ndata: ${JSON.stringify(incident)}\n\n`);
    });
    request.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }),

  patternRoute(
    /^\/api\/errors\/(\d+)\/prompt$/,
    ["id"],
    async ({ request, response, params, errorInbox }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const payload = await errorInbox.buildPrompt(Number(params.id));
      if (!payload) {
        sendJson(response, { ok: false, error: "Incident not found" }, 404);
        return;
      }
      sendJson(response, { ok: true, ...payload });
    },
  ),
];
