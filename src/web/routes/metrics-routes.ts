import { terminateSystemProcess } from "../../core/system-processes.js";
import { readJson, sendJson } from "../http-utils.js";
import { errorMessage, patternRoute, route, type Route } from "./context.js";

/** Host activity and per-service CPU/RSS time series. */
export const metricsRoutes: Route[] = [
  route("GET", "/api/metrics", ({ response, metricsStore, url }) => {
    const metrics = metricsStore.readActivity();
    sendJson(response, {
      ok: true,
      metrics:
        url.searchParams.get("includeProcesses") === "1"
          ? metrics
          : { ...metrics, systemProcesses: undefined },
    });
  }),

  route(
    "POST",
    "/api/processes/terminate",
    async ({ request, response, manager }) => {
      const body: Record<string, unknown> = await readJson(request).catch(
        () => ({}),
      );
      const pid = Number(body.pid);
      const expectedCommand =
        typeof body.expectedCommand === "string" ? body.expectedCommand : "";
      if (!Number.isSafeInteger(pid) || !expectedCommand) {
        sendJson(response, { ok: false, error: "pid and expectedCommand are required" }, 400);
        return;
      }
      const roots = Object.values(manager.status().services)
        .filter((status) => status.state === "running" && status.pid)
        .map((status) => ({ pid: status.pid as number, service: status.name }));
      try {
        await terminateSystemProcess(pid, expectedCommand, roots);
        sendJson(response, { ok: true });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 409);
      }
    },
  ),

  patternRoute(
    /^\/api\/services\/([^/]+)\/metrics$/,
    ["name"],
    ({ request, response, params, metricsStore }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const name = decodeURIComponent(params.name);
      sendJson(response, { ok: true, metrics: metricsStore.read(name) });
    },
  ),
];
