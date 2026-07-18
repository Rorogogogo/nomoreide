import { appVersion } from "../../core/app-version.js";
import { buildDashboardPayload } from "../dashboard.js";
import { listDirectories } from "../directories.js";
import { sendJson } from "../http-utils.js";
import { route, type Route } from "./context.js";

/** Overview / system endpoints: dashboard, health, status, directory browse. */
export const dashboardRoutes: Route[] = [
  route("GET", "/api/dashboard", async ({ response, configStore, cwd, logStore, manager, timelineStore }) => {
    sendJson(
      response,
      await buildDashboardPayload({ configStore, cwd, logStore, manager, timelineStore }),
    );
  }),

  route("GET", "/api/health", ({ response }) => {
    // version + pid let daemon clients detect skew and identify the owner.
    sendJson(response, {
      ok: true,
      app: "nomoreide",
      version: appVersion(),
      pid: process.pid,
    });
  }),

  route("GET", "/api/status", ({ response, manager }) => {
    sendJson(response, { ok: true, status: manager.status() });
  }),

  route("GET", "/api/timeline", ({ response, url, timelineStore }) => {
    const requested = Number(url.searchParams.get("limit"));
    const limit =
      Number.isFinite(requested) && requested > 0
        ? Math.min(Math.floor(requested), 500)
        : 120;
    sendJson(response, { ok: true, timeline: timelineStore.read(limit) });
  }),

  route("POST", "/api/daemon/shutdown", ({ response, manager, onDaemonShutdown }) => {
    const running = Object.values(manager.status().services).filter(
      (service) => service.state === "running" || service.state === "starting",
    ).length;
    // Answer first so the caller isn't left hanging on a socket the exiting
    // process tears down; services are stopped right after.
    sendJson(response, { ok: true, stoppingServices: running });
    setImmediate(() => {
      void manager
        .stopAll()
        .catch(() => {})
        .then(() => onDaemonShutdown?.());
    });
  }),

  route("GET", "/api/fs/directories", async ({ response, url, cwd }) => {
    const includeFiles = url.searchParams.get("files") === "1";
    sendJson(
      response,
      await listDirectories(url.searchParams.get("path")?.trim() || cwd, { includeFiles }),
    );
  }),
];
