import { sendJson } from "../http-utils.js";
import { patternRoute, route, type Route } from "./context.js";

/** Host activity and per-service CPU/RSS time series. */
export const metricsRoutes: Route[] = [
  route("GET", "/api/metrics", ({ response, metricsStore }) => {
    sendJson(response, { ok: true, metrics: metricsStore.readActivity() });
  }),

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
