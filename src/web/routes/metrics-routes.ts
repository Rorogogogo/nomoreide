import { bucketLogVolume } from "../../core/log-volume.js";
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

  /*
    The series and its log volume travel together, in that order of authority:
    the samples define the window, and the buckets are counted over exactly that
    window (`bucketLogVolume`). One response rather than two endpoints because
    they are one axis — a second request could answer from a slightly later ring
    buffer and put the two charts a poll apart — and because the Logs panel polls
    this on a timer, where a second connection per panel is how the browser's
    six-per-host budget goes.
  */
  patternRoute(
    /^\/api\/services\/([^/]+)\/metrics$/,
    ["name"],
    ({ request, response, params, logStore, metricsStore }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const name = decodeURIComponent(params.name);
      const series = metricsStore.read(name);
      sendJson(response, {
        ok: true,
        metrics: {
          ...series,
          logVolume: bucketLogVolume(logStore.read(name), series.samples),
        },
      });
    },
  ),
];
