import {
  getDockerStatus,
  listDockerContainers,
  performDockerContainerAction,
  readDockerContainerLogs,
  type DockerContainerAction,
} from "../../core/docker.js";
import { sendJson } from "../http-utils.js";
import { errorMessage, patternRoute, route, type Route } from "./context.js";

const CONTAINER_ACTIONS = new Set<DockerContainerAction>(["start", "stop", "restart"]);

/**
 * Read-mostly Docker visibility: whatever's running on the host, registered
 * as a nomoreide service or not. `status` and `containers` are read-on-mount
 * (mirrored in `website/src/mock-api.ts`); actions/logs are click-driven.
 */
export const dockerRoutes: Route[] = [
  route("GET", "/api/docker/status", async ({ response }) => {
    sendJson(response, { ok: true, status: await getDockerStatus() });
  }),

  route("GET", "/api/docker/containers", async ({ response }) => {
    try {
      sendJson(response, { ok: true, containers: await listDockerContainers() });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 500);
    }
  }),

  patternRoute(
    /^\/api\/docker\/containers\/([^/]+)\/(start|stop|restart)$/,
    ["id", "action"],
    async ({ request, response, params }) => {
      if (request.method !== "POST") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const action = params.action as DockerContainerAction;
      if (!CONTAINER_ACTIONS.has(action)) {
        sendJson(response, { ok: false, error: `Unknown action "${action}"` }, 400);
        return;
      }
      try {
        await performDockerContainerAction(decodeURIComponent(params.id), action);
        sendJson(response, { ok: true });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 500);
      }
    },
  ),

  patternRoute(
    /^\/api\/docker\/containers\/([^/]+)\/logs$/,
    ["id"],
    async ({ request, response, params, url }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const tailParam = Number(url.searchParams.get("tail"));
      try {
        const logs = await readDockerContainerLogs(
          decodeURIComponent(params.id),
          Number.isFinite(tailParam) && tailParam > 0 ? tailParam : undefined,
        );
        sendJson(response, { ok: true, logs });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 500);
      }
    },
  ),
];
