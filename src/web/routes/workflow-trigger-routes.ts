import { workflowTriggerSchema } from "../../core/workflow-triggers.js";
import { readJson, sendJson } from "../http-utils.js";
import { errorMessage, patternRoute, route, type Route } from "./context.js";

/**
 * Event-driven workflow triggers (IDEAS #16). CRUD persists bindings through
 * ConfigStore; the manager owns the live event subscriptions and the
 * pending-run queue. The workflow runner stays client-side, so the dashboard
 * drains the queue (`/pending` + SSE) and drives the existing runner — there's
 * no server-side "run" here.
 */
export const workflowTriggerRoutes: Route[] = [
  route("GET", "/api/workflow-triggers", async ({ response, configStore }) => {
    try {
      const config = await configStore.load();
      sendJson(response, { ok: true, triggers: config.workflowTriggers });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  route("POST", "/api/workflow-triggers", async ({ request, response, configStore }) => {
    try {
      const body = await readJson(request);
      const trigger = workflowTriggerSchema.parse(body);
      const config = await configStore.saveWorkflowTrigger(trigger);
      sendJson(response, { ok: true, triggers: config.workflowTriggers });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  route("GET", "/api/workflow-triggers/pending", ({ response, triggerManager }) => {
    sendJson(response, { ok: true, pending: triggerManager.listPending() });
  }),

  route("GET", "/api/workflow-triggers/pending/stream", ({ request, response, triggerManager }) => {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    response.write(`retry: 2000\n\n`);
    for (const pending of triggerManager.listPending()) {
      response.write(`event: pending\ndata: ${JSON.stringify(pending)}\n\n`);
    }
    const heartbeat = setInterval(() => {
      response.write(`: ping\n\n`);
    }, 15000);
    const unsubscribe = triggerManager.subscribe((pending) => {
      response.write(`event: pending\ndata: ${JSON.stringify(pending)}\n\n`);
    });
    request.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }),

  patternRoute(
    /^\/api\/workflow-triggers\/pending\/([^/]+)\/ack$/,
    ["id"],
    ({ request, response, params, triggerManager }) => {
      if (request.method !== "POST") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const removed = triggerManager.ackPending(decodeURIComponent(params.id));
      sendJson(response, { ok: removed }, removed ? 200 : 404);
    },
  ),

  patternRoute(
    /^\/api\/workflow-triggers\/([^/]+)$/,
    ["id"],
    async ({ request, response, configStore, params }) => {
      if (request.method !== "DELETE") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      try {
        const config = await configStore.removeWorkflowTrigger(decodeURIComponent(params.id));
        sendJson(response, { ok: true, triggers: config.workflowTriggers });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      }
    },
  ),
];
