import { sendJson } from "../http-utils.js";
import { errorMessage, patternRoute, route, type Route } from "./context.js";

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

  patternRoute(
    /^\/api\/errors\/(\d+)\/bundle$/,
    ["id"],
    async ({ request, response, params, url, reproBundle }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const save = url.searchParams.get("save") === "1";
      const payload = await reproBundle.build(Number(params.id), { save });
      if (!payload) {
        sendJson(response, { ok: false, error: "Incident not found" }, 404);
        return;
      }
      sendJson(response, { ok: true, ...payload });
    },
  ),

  // Error → Fix loop: snapshot the working tree, record an agent session, and
  // return the repro-bundle fix prompt. The client then runs the prompt in the
  // dock; the agent's edits surface as the recorded session's change-set.
  patternRoute(
    /^\/api\/errors\/(\d+)\/fix$/,
    ["id"],
    async ({ request, response, params, fixLoop }) => {
      if (request.method !== "POST") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      try {
        const prep = await fixLoop.prepare(Number(params.id));
        if (!prep) {
          sendJson(response, { ok: false, error: "Incident not found" }, 404);
          return;
        }
        sendJson(response, { ok: true, ...prep });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      }
    },
  ),
];
