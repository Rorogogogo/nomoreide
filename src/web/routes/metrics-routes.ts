import { sendJson } from "../http-utils.js";
import { patternRoute, type Route } from "./context.js";

/** Per-service CPU/RSS time series for the metrics chart. */
export const metricsRoutes: Route[] = [
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
